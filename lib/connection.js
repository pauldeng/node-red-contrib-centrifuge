"use strict";
// Node-RED-free owner of one centrifuge-js client: validation, lifecycle, status snapshot, subscription registry,
// server-side subscription map, bounded operations and synchronous close. nodes/centrifuge-server.js is thin glue.
// Behaviour relied on here was verified against centrifuge-js 5.7.4 and Centrifugo 6.9.4 (see test/runtime and test/docker).
const { Centrifuge, State } = require("centrifuge");
const { connectionToken, subscriptionToken } = require("./jwt");
const { coded, fromSdkError } = require("./errors");
const { STATUS } = require("./status");
const { runBounded } = require("./lifecycle");
const { version } = require("../package.json");

const AUTH = new Set(["hmac", "token", "none"]);
const SUB_AUTH = new Set(["none", "hmac"]);

function int(value, name, min, max) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max)
    throw coded("INVALID_CONFIG", `${name} must be an integer from ${min} to ${max}`);
  return n;
}

// One channel per line (commas are valid inside channel names, e.g. personal:#17,42).
function parseChannels(text) {
  if (text === undefined || text === "") return [];
  if (typeof text !== "string") throw coded("INVALID_CONFIG", "channels must be text with one channel per line");
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

function validate(opts) {
  let url;
  try {
    if (typeof opts.url !== "string") throw new Error();
    url = new URL(opts.url);
  } catch {
    throw coded("INVALID_CONFIG", "url must be an absolute ws:// or wss:// URL");
  }
  if (!["ws:", "wss:"].includes(url.protocol) || !url.hostname)
    throw coded("INVALID_CONFIG", "url must be an absolute ws:// or wss:// URL");
  if (url.username || url.password) throw coded("INVALID_CONFIG", "url must not contain credentials");
  if (url.href.includes("#")) throw coded("INVALID_CONFIG", "url must not contain a fragment");
  const auth = opts.auth === undefined ? "hmac" : opts.auth;
  if (!AUTH.has(auth)) throw coded("INVALID_CONFIG", "auth must be hmac, token or none");
  const user = auth !== "hmac" || opts.user === undefined ? "node-red" : opts.user;
  if (typeof user !== "string") throw coded("INVALID_CONFIG", "user must be a string");
  const cfg = {
    url: url.href,
    auth,
    user,
    channels: auth === "hmac" ? parseChannels(opts.channels) : [],
    ttl: int(auth !== "hmac" || opts.ttl === undefined ? 3600 : opts.ttl, "ttl", 60, 86400),
    timeout: int(opts.timeout === undefined ? 5000 : opts.timeout, "timeout", 100, 60000),
    maxMessageSize: int(
      opts.maxMessageSize === undefined ? 65536 : opts.maxMessageSize,
      "maxMessageSize",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    secret: opts.secret,
    token: opts.token,
  };
  if (auth === "hmac" && (typeof cfg.secret !== "string" || cfg.secret === ""))
    throw coded("INVALID_CONFIG", "hmac auth needs the secret credential");
  if (auth === "token" && (typeof cfg.token !== "string" || cfg.token === ""))
    throw coded("INVALID_CONFIG", "token auth needs the token credential");
  return cfg;
}

// createConnection({ url, auth, user, channels, ttl, timeout, maxMessageSize, secret, token, log })
// -> { connect, close, status, onStatus, subscribe, onServerSide, run, maxMessageSize, timeout, closing }
function createConnection(opts) {
  const cfg = validate(opts);
  const log = { debug() {}, warn() {}, ...opts.log };
  const sdkOptions = { name: "node-red", version, timeout: cfg.timeout };
  if (cfg.auth === "hmac") {
    // Called by the SDK before the first connect and on every server-driven refresh (probe P1d). Cannot fail once the
    // secret is present; never return "" (the server rejects it with 3501 instead of the unauthorized path, probe P5b).
    sdkOptions.getToken = async () =>
      connectionToken({ secret: cfg.secret, sub: cfg.user, ttl: cfg.ttl, channels: cfg.channels });
  } else if (cfg.auth === "token") {
    sdkOptions.token = cfg.token;
  }
  const client = new Centrifuge(cfg.url, sdkOptions);

  let closing = false;
  const closeController = new AbortController();
  let started = false;
  let connection = STATUS.connecting;
  const statusListeners = new Set();
  const waiters = new Set(); // run() callers waiting for readiness
  const registry = new Map(); // channel -> entry (client-side subscriptions)
  const serverChannels = new Map(); // channel -> "subscribing" | "subscribed" (server-side subscriptions)
  const serverConsumers = new Set();

  const isTerminal = () => connection.terminal === true;
  const publishConnection = (status) => {
    if (closing) return;
    connection = status;
    for (const fn of statusListeners) fn(status);
    for (const entry of registry.values()) entry.push();
    for (const c of serverConsumers) c.onStatus?.(serverStatus(c));
  };
  const serverStatus = (consumer) => {
    if (isTerminal() || connection !== STATUS.connected || !consumer.channel) return connection;
    return serverChannels.get(consumer.channel) === "subscribed" ? STATUS.subscribed : STATUS.awaitingServer;
  };
  const eventContext = (event, ctx) => {
    const out = { event, channel: ctx.channel };
    if (event === "publication") {
      out.data = ctx.data;
      if (ctx.offset !== undefined) out.offset = ctx.offset;
      if (ctx.tags !== undefined) out.tags = ctx.tags;
      if (ctx.info !== undefined) out.info = ctx.info;
    } else out.info = ctx.info;
    return out;
  };

  const handlers = {
    connecting: () => {
      // Fires once per transition, including a reconnectable server disconnect (probe P7); retries emit `error`.
      serverChannels.clear();
      publishConnection(STATUS.connecting);
    },
    connected: () => {
      publishConnection(STATUS.connected);
      for (const w of waiters) w.resolve();
      waiters.clear();
    },
    disconnected: (ctx) => {
      // Only terminal closes reach this event (probe P7): SDK unauthorized (1) or server codes 3500-3999 / 4500-4999.
      if (closing) return;
      serverChannels.clear();
      publishConnection(STATUS.disconnected(ctx.reason, ctx.code));
      const err = coded("NOT_CONNECTED", connection.text);
      for (const w of waiters) w.reject(err);
      waiters.clear();
    },
    error: (ctx) => {
      // Transport retries are noise at debug level; a configuration error (code 12, e.g. an expired static token
      // with no refresh, probe P5b) is the user's problem and is logged once at warn level.
      if (closing) return;
      const detail = fromSdkError(ctx.error).message;
      if (ctx.type === "configuration") log.warn(`centrifuge ${detail}`);
      else log.debug(`centrifuge ${detail}`);
    },
    subscribing: (ctx) => {
      serverChannels.set(ctx.channel, "subscribing");
      for (const c of serverConsumers) if (c.channel === ctx.channel) c.onStatus?.(serverStatus(c));
    },
    subscribed: (ctx) => {
      serverChannels.set(ctx.channel, "subscribed");
      for (const c of serverConsumers) if (c.channel === ctx.channel) c.onStatus?.(serverStatus(c));
    },
    unsubscribed: (ctx) => {
      serverChannels.delete(ctx.channel);
      for (const c of serverConsumers) if (c.channel === ctx.channel) c.onStatus?.(serverStatus(c));
    },
    publication: (ctx) => fanOutServer("publication", ctx),
    join: (ctx) => fanOutServer("join", ctx),
    leave: (ctx) => fanOutServer("leave", ctx),
  };
  function fanOutServer(event, ctx) {
    if (closing) return;
    const out = eventContext(event, ctx);
    for (const c of serverConsumers)
      if ((!c.channel || c.channel === ctx.channel) && (event === "publication" || c.joinLeave)) c.onEvent?.(out);
  }
  for (const [name, fn] of Object.entries(handlers)) client.on(name, fn);

  function createEntry(channel, { joinLeave, auth }) {
    const entry = { channel, joinLeave, auth, consumers: new Set(), status: STATUS.subscribing, sub: null };
    entry.combined = () => (connection !== STATUS.connected ? connection : entry.status);
    entry.push = () => {
      if (closing) return;
      const s = entry.combined();
      for (const c of entry.consumers) c.onStatus?.(s);
    };
    entry.attach = () => {
      const options = { joinLeave: entry.joinLeave };
      if (entry.auth === "hmac")
        options.getToken = async (ctx) =>
          subscriptionToken({ secret: cfg.secret, sub: cfg.user, channel: ctx.channel, ttl: cfg.ttl });
      const sub = client.newSubscription(channel, options);
      // join/leave go only to consumers that opted in: the server may force-push them regardless (probe P4e).
      const deliver = (event) => (ctx) => {
        if (closing || entry.sub !== sub) return;
        const out = eventContext(event, { ...ctx, channel });
        for (const c of entry.consumers) if (event === "publication" || c.joinLeave) c.onEvent?.(out);
      };
      const owned = new Map();
      const on = (event, handler) => {
        owned.set(event, handler);
        sub.on(event, handler);
      };
      entry.detach = () => {
        for (const [event, handler] of owned) sub.off(event, handler);
      };
      on("publication", deliver("publication"));
      on("join", deliver("join"));
      on("leave", deliver("leave"));
      on("subscribing", () => {
        if (entry.sub !== sub) return;
        entry.status = STATUS.subscribing;
        entry.push();
      });
      on("subscribed", () => {
        if (entry.sub !== sub) return;
        entry.status = STATUS.subscribed;
        entry.push();
      });
      // A refused subscribe emits no `error`; it goes straight to `unsubscribed` with the server code (probe P1e/P7).
      on("unsubscribed", (ctx) => {
        if (entry.sub !== sub) return;
        entry.status = STATUS.unsubscribed(ctx.reason, ctx.code);
        entry.push();
      });
      on(
        "error",
        (ctx) =>
          !closing && entry.sub === sub && log.debug(`centrifuge subscription: ${fromSdkError(ctx.error).message}`),
      );
      entry.sub = sub;
      sub.subscribe();
    };
    entry.destroy = () => {
      const sub = entry.sub;
      entry.sub = null;
      entry.detach?.();
      entry.detach = null;
      if (sub) client.removeSubscription(sub); // unsubscribes internally; no separate unsubscribe() call
    };
    // Upgrading joinLeave has no SDK setter: recreate this channel's subscription only (brief gap, probe P4e).
    entry.recreate = (changes) => {
      Object.assign(entry, changes);
      entry.destroy();
      entry.status = STATUS.subscribing;
      entry.attach();
    };
    entry.attach();
    return entry;
  }

  // subscribe(channel, { onEvent, onStatus }, { joinLeave, subscriptionAuth }) -> dispose()
  function subscribe(channel, consumer, { joinLeave = false, subscriptionAuth = "none" } = {}) {
    if (closing) throw coded("CLOSING");
    if (typeof channel !== "string" || !channel.trim())
      throw coded("INVALID_CONFIG", "channel must be a non-empty string");
    if (typeof joinLeave !== "boolean") throw coded("INVALID_CONFIG", "joinLeave must be a boolean");
    if (!SUB_AUTH.has(subscriptionAuth)) throw coded("INVALID_CONFIG", "subscriptionAuth must be none or hmac");
    if (subscriptionAuth === "hmac" && cfg.auth !== "hmac")
      throw coded("INVALID_CONFIG", "subscription tokens need server auth hmac");
    if (cfg.channels.includes(channel))
      throw coded("CONFIG_CONFLICT", "channel is a server-side subscription of this server (105)");
    let entry = registry.get(channel);
    if (entry && entry.auth !== subscriptionAuth)
      throw coded("INVALID_CONFIG", "subscription auth differs from the existing subscription");
    if (!entry) {
      entry = createEntry(channel, { joinLeave: joinLeave === true, auth: subscriptionAuth });
      registry.set(channel, entry);
    } else if (joinLeave === true && !entry.joinLeave) {
      entry.recreate({ joinLeave: true });
    }
    consumer.joinLeave = joinLeave === true;
    entry.consumers.add(consumer);
    consumer.onStatus?.(entry.combined());
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      entry.consumers.delete(consumer);
      if (entry.consumers.size === 0 && registry.get(channel) === entry) {
        registry.delete(channel);
        entry.destroy();
      }
    };
  }

  // onServerSide({ channel?, joinLeave?, onEvent, onStatus }) -> dispose(); events granted by the token or the server.
  // join/leave reach only consumers with joinLeave: true, as for client-side subscriptions.
  function onServerSide(consumer) {
    if (closing) throw coded("CLOSING");
    if (
      consumer.channel !== undefined &&
      (typeof consumer.channel !== "string" || (consumer.channel !== "" && !consumer.channel.trim()))
    )
      throw coded("INVALID_CONFIG", "channel filter must be a string");
    if (consumer.channel === "") consumer.channel = undefined;
    serverConsumers.add(consumer);
    consumer.onStatus?.(serverStatus(consumer));
    return () => serverConsumers.delete(consumer);
  }

  function onStatus(fn) {
    statusListeners.add(fn);
    fn(connection);
    return () => statusListeners.delete(fn);
  }

  async function waitConnected(signal) {
    signal.throwIfAborted();
    const w = Promise.withResolvers();
    const onAbort = () => w.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    waiters.add(w);
    try {
      await w.promise;
    } finally {
      waiters.delete(w);
      signal.removeEventListener("abort", onAbort);
    }
  }

  // prepare(check) evaluates and snapshots input before readiness; all phases share one deadline and cancellation.
  // A terminal connection fails fast (the SDK alone would wait the whole timeout, probe P2); connecting waits.
  async function run(work, { signal, timeout = cfg.timeout, prepare } = {}) {
    if (closing) throw coded("CLOSING");
    return runBounded(
      async (combined, check) => {
        check();
        const prepared = prepare ? await prepare(check) : undefined;
        check();
        if (client.state === State.Disconnected || isTerminal()) throw coded("NOT_CONNECTED", connection.text);
        if (client.state !== State.Connected) await waitConnected(combined);
        check();
        if (closing) throw coded("CLOSING");
        if (client.state !== State.Connected) throw coded("NOT_CONNECTED");
        try {
          return await work(client, prepared);
        } catch (err) {
          throw fromSdkError(err);
        }
      },
      { signal: signal ? AbortSignal.any([signal, closeController.signal]) : closeController.signal, timeout },
    );
  }

  function connect() {
    if (closing || started) return;
    started = true;
    client.connect();
  }

  // Synchronous and bounded: disconnect first so removing subscriptions sends no commands (probe P3).
  function close() {
    if (closing) return;
    closing = true;
    closeController.abort(coded("CLOSING"));
    for (const [name, fn] of Object.entries(handlers)) client.off(name, fn); // the SDK's default error listener stays
    client.disconnect();
    for (const entry of registry.values()) entry.destroy();
    registry.clear();
    serverChannels.clear();
    serverConsumers.clear();
    statusListeners.clear();
    const err = coded("CLOSING");
    for (const w of waiters) w.reject(err);
    waiters.clear();
  }

  return {
    connect,
    close,
    subscribe,
    onServerSide,
    onStatus,
    run,
    status: () => connection,
    get closing() {
      return closing;
    },
    get started() {
      return started;
    },
    timeout: cfg.timeout,
    maxMessageSize: cfg.maxMessageSize,
    client, // tests and diagnostics only; nodes never touch it directly
  };
}

module.exports = { createConnection, validate, parseChannels };
