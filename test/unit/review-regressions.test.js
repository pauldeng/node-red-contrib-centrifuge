"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { prepareCommand } = require("../../lib/payload");
const { fromSdkError, coded } = require("../../lib/errors");
const { STATUS } = require("../../lib/status");
const { validate, createConnection } = require("../../lib/connection");
const { runBounded } = require("../../lib/lifecycle");

function makeNode(type, config, server, evaluator = (_v, _t, _n, msg, cb) => cb(null, msg.topic)) {
  let Constructor;
  const RED = {
    nodes: {
      registerType: (_type, ctor) => {
        Constructor = ctor;
      },
      getNode: () => server,
      createNode(node) {
        const events = new EventEmitter();
        node.id = "test-node";
        node.on = events.on.bind(events);
        node.emit = events.emit.bind(events);
        node.statuses = [];
        node.errors = [];
        node.status = (status) => node.statuses.push(status);
        node.error = (err) => node.errors.push(err);
      },
    },
    util: { evaluateNodeProperty: evaluator, cloneMessage: (msg) => structuredClone(msg) },
  };
  require(`../../nodes/${type}`)(RED);
  return new Constructor(config);
}
const stubServer = () => ({
  timeout: 50,
  maxMessageSize: 65536,
  calls: 0,
  register(_node, render) {
    this.render = render;
    render(STATUS.connected);
  },
  deregister() {},
  async run(work, { signal, prepare } = {}) {
    return runBounded(
      async (_signal, check) => {
        const data = await prepare(check);
        check();
        return work(
          this.client ?? {
            ...Object.fromEntries(
              ["publish", "rpc", "history", "presence", "presenceStats"].map((action) => [
                action,
                async () => {
                  this.calls++;
                  this.entered?.resolve();
                  return this.ack ? await this.ack.promise : {};
                },
              ]),
            ),
          },
          data,
        );
      },
      { signal, timeout: this.timeout },
    );
  },
});
const input = (node, msg) => {
  const result = Promise.withResolvers();
  const sent = [];
  const errors = [];
  node.emit(
    "input",
    msg,
    (out) => sent.push(out),
    (err) => {
      errors.push(err);
      result.resolve(err);
    },
  );
  return { result: result.promise, sent, errors };
};

for (const type of ["centrifuge-out", "centrifuge-request"]) {
  test(`${type}: deadline covers a stalled evaluator, and a late result never publishes`, async () => {
    const server = stubServer();
    let callback;
    const node = makeNode(type, { channel: "target", channelType: "global" }, server, (_v, _t, _n, _m, cb) => {
      callback = cb;
    });
    const op = input(node, { payload: "hello" });
    const err = await runBounded(() => op.result, { timeout: 300 });
    assert.equal(err.code, "TIMEOUT");
    callback(null, "news");
    await nextTurn();
    assert.equal(server.calls, 0);
    assert.equal(op.errors.length, 1);
    assert.equal(op.sent.length, 0);
  });
}

for (const type of ["centrifuge-out", "centrifuge-request"]) {
  test(`${type}: close cancels a stalled evaluator without waiting for its callback`, async () => {
    const server = stubServer();
    let callback;
    const node = makeNode(type, { channel: "target", channelType: "global" }, server, (_v, _t, _n, _m, cb) => {
      callback = cb;
    });
    const op = input(node, { payload: "hello" });
    const closed = Promise.withResolvers();
    node.emit("close", false, closed.resolve);
    await runBounded(() => closed.promise, { timeout: 300 });
    assert.equal(await op.result, undefined);
    callback(null, "news");
    await nextTurn();
    assert.equal(server.calls, 0);
    assert.equal(op.errors.length, 1);
  });
}

test("input configuration failure is not overwritten by connection status", () => {
  const server = stubServer();
  server.subscribe = () => {
    throw coded("CONFIG_CONFLICT");
  };
  const node = makeNode("centrifuge-in", { mode: "subscribe", channel: "news" }, server);
  server.render?.(STATUS.connected);
  assert.equal(node.statuses.at(-1).fill, "red");
});

test("invalid input modes and channel selectors fail without I/O", async () => {
  const server = stubServer();
  let subscriptions = 0;
  server.subscribe = () => {
    subscriptions++;
    return () => {};
  };
  const node = makeNode("centrifuge-in", { mode: "typo", channel: "news" }, server);
  assert.equal(subscriptions, 0);
  assert.equal(node.statuses.at(-1).fill, "red");
  const out = makeNode("centrifuge-out", { channel: "news", channelType: "typo" }, server);
  assert.equal((await input(out, { topic: "news", payload: 1 }).result).code, "INVALID_CONFIG");
  const whitespace = makeNode("centrifuge-out", { channel: "topic", channelType: "msg" }, server);
  assert.equal((await input(whitespace, { topic: "   ", payload: 1 }).result).code, "INVALID_MESSAGE");
  assert.equal(server.calls, 0);
});

test("serialization reads getters once, rejects binary in classes and hook results, and sanitizes throws", () => {
  let reads = 0;
  const data = {
    get value() {
      return ++reads;
    },
  };
  assert.deepEqual(prepareCommand("publish", { channel: "news" }, data, 65536).data, { value: 1 });
  assert.equal(reads, 1);
  class Binary {
    constructor() {
      this.data = Buffer.from("secret");
    }
  }
  for (const value of [
    new Binary(),
    { toJSON: () => ({ data: new Uint8Array(1) }) },
    { toJSON: () => Buffer.from("x") },
  ]) {
    assert.throws(
      () => prepareCommand("publish", { channel: "news" }, value, 65536),
      (e) => e.code === "INVALID_MESSAGE",
    );
  }
  assert.throws(
    () =>
      prepareCommand(
        "publish",
        {},
        {
          get value() {
            throw Error("secret-token");
          },
        },
        65536,
      ),
    (e) => e.code === "INVALID_MESSAGE" && !e.message.includes("secret-token"),
  );
});

test("diagnostics never forward external reason strings or inherited error codes", () => {
  for (const e of [
    { code: 103, message: "secret-token" },
    Error("secret-token"),
    { code: "toString", message: "secret-token" },
    { code: "INVALID_MESSAGE", message: "secret-token" },
  ]) {
    assert.doesNotMatch(JSON.stringify(fromSdkError(e), Object.getOwnPropertyNames(fromSdkError(e))), /secret-token/);
  }
  assert.doesNotMatch(STATUS.disconnected("secret-token", 4500).text, /secret-token/);
  assert.doesNotMatch(STATUS.unsubscribed("secret-token", 103).text, /secret-token/);
});

test("URL empty fragments are rejected, inactive HMAC fields are ignored", () => {
  assert.throws(
    () => validate({ url: "ws://localhost/#", auth: "none" }),
    (e) => e.code === "INVALID_CONFIG",
  );
  const cfg = validate({ url: "ws://localhost/", auth: "none", channels: ["news"], ttl: "bad" });
  assert.deepEqual(cfg.channels, []);
  for (const field of ["timeout", "maxMessageSize"]) {
    assert.throws(
      () => validate({ url: "ws://localhost/", auth: "none", [field]: null }),
      (e) => e.code === "INVALID_CONFIG",
    );
  }
});

test("disposing a subscription detaches owned SDK listeners", () => {
  const conn = createConnection({ url: "ws://localhost/", auth: "none" });
  try {
    const dispose = conn.subscribe("news", {});
    const sub = conn.client.getSubscription("news");
    dispose();
    for (const event of ["publication", "join", "leave", "subscribing", "subscribed", "unsubscribed"]) {
      assert.equal(sub.listenerCount(event), 0, event);
    }
    assert.equal(sub.listenerCount("error"), 1, "SDK default listener retained");
  } finally {
    conn.close();
  }
});

test("a 500-input reconnect burst uses shared readiness listeners", async () => {
  const conn = createConnection({ url: "ws://127.0.0.1:1/", auth: "none", timeout: 100 });
  conn.connect();
  const ac = new AbortController();
  const pending = Promise.allSettled(Array.from({ length: 500 }, () => conn.run(() => {}, { signal: ac.signal })));
  try {
    assert.ok(
      conn.client.listenerCount("connected") <= 2,
      "one readiness listener per input leaks listeners under bursts",
    );
  } finally {
    ac.abort(coded("CLOSING"));
    await pending;
    conn.close();
  }
});

test("connection close cancels in-flight work with CLOSING", async () => {
  // Readiness only is simulated; this verifies operation ownership rather than a transport behavior.
  const conn = createConnection({ url: "ws://localhost/", auth: "none", timeout: 1000 });
  conn.client.state = "connected";
  const entered = new EventEmitter();
  const ready = once(entered, "work");
  const pending = conn.run(async () => {
    entered.emit("work");
    return await Promise.withResolvers().promise;
  });
  const rejected = assert.rejects(pending, (e) => e.code === "CLOSING");
  await ready;
  conn.close();
  await rejected;
});

test("cancellation between readiness and dispatch prevents sending", async () => {
  const conn = createConnection({ url: "ws://localhost/", auth: "none" });
  const ac = new AbortController();
  let calls = 0;
  try {
    conn.client.state = "connecting";
    const pending = conn.run(
      () => {
        calls++;
      },
      { signal: ac.signal },
    );
    conn.client.state = "connected";
    conn.client.emit("connected", {});
    ac.abort(coded("CLOSING"));
    await assert.rejects(pending, (e) => e.code === "CLOSING");
    assert.equal(calls, 0);
  } finally {
    conn.close();
  }
});

test("connection diagnostics omit raw SDK messages, types and subscription channels", () => {
  const logs = [];
  const conn = createConnection({
    url: "ws://localhost/",
    auth: "none",
    log: { debug: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  try {
    conn.client.emit("error", { type: "secret-token", error: { code: 2, message: "secret-token" } });
    const dispose = conn.subscribe("secret-token", {});
    const sub = conn.client.getSubscription("secret-token");
    sub.emit("error", { type: "secret-token", error: { code: 103, message: "secret-token" } });
    assert.equal(logs.length, 2);
    assert.doesNotMatch(logs.join("\n"), /secret-token/);
    dispose();
    sub.emit("error", { error: { code: 103, message: "late" } });
    assert.equal(logs.length, 2);
  } finally {
    conn.close();
  }
});

for (const type of ["centrifuge-out", "centrifuge-request"]) {
  test(`${type}: an acknowledgement racing close settles quietly once and emits no output`, async () => {
    const server = stubServer();
    server.ack = Promise.withResolvers();
    server.entered = Promise.withResolvers();
    const node = makeNode(type, {}, server);
    const op = input(node, { topic: "news", payload: 1 });
    await server.entered.promise;
    const closed = Promise.withResolvers();
    server.ack.resolve({});
    node.emit("close", false, closed.resolve);
    await closed.promise;
    assert.equal(await op.result, undefined);
    assert.equal(op.errors.length, 1);
    assert.equal(op.sent.length, 0);
    assert.equal(
      (await input(node, { topic: "news", payload: 2 }).result).code,
      "CLOSING",
      "new input after close still fails",
    );
  });
}

test("a throwing consumer neither starves its siblings nor escapes into the SDK emitter", () => {
  const warnings = [];
  const conn = createConnection({ url: "ws://localhost/", auth: "none", log: { warn: (m) => warnings.push(m) } });
  try {
    const seen = [];
    conn.subscribe("news", {
      onEvent: () => {
        throw new Error("consumer bug secret-token");
      },
    });
    conn.subscribe("news", { onEvent: (ctx) => seen.push(ctx.data) });
    const sub = conn.client.getSubscription("news");
    assert.doesNotThrow(() => sub.emit("publication", { channel: "news", data: 1 }));
    assert.deepEqual(seen, [1], "the sibling still received the publication");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /consumer callback failed/);
    assert.doesNotMatch(warnings[0], /secret-token|consumer bug/);
    assert.doesNotThrow(() => conn.client.emit("connected", {}));
  } finally {
    conn.close();
  }
});

test("runBounded returns a value that resolved before abort even if the clock passed the deadline meanwhile", async () => {
  const realNow = performance.now;
  try {
    const result = await runBounded(
      async () => {
        performance.now = () => realNow.call(performance) + 3_600_000; // the loop was busy; the deadline is "past"
        return "acknowledged";
      },
      { timeout: 50 },
    );
    assert.equal(result, "acknowledged");
  } finally {
    performance.now = realNow;
  }
});

for (const action of ["history", "presence", "presence_stats"]) {
  test(`request ${action}: oversize target is rejected before dispatch`, async () => {
    const server = stubServer();
    server.maxMessageSize = 100;
    const node = makeNode("centrifuge-request", { action }, server);
    const op = input(node, { topic: "é".repeat(100) });
    assert.equal((await op.result).code, "INVALID_MESSAGE");
    assert.equal(server.calls, 0);
    assert.equal(op.sent.length, 0);
  });
}

test("centrifuge-out map_remove: oversize key is refused before dispatch", async () => {
  const server = stubServer();
  server.maxMessageSize = 100;
  // the default evaluator echoes msg.topic regardless of which selector is asked for; distinguish the two calls
  // (channel, then key) by the selector text itself so the channel stays short and only the key is oversize.
  const node = makeNode(
    "centrifuge-out",
    { mode: "map_remove", channel: "topic", channelType: "msg", key: "bigkey", keyType: "msg" },
    server,
    (value, _type, _node, msg, cb) => cb(null, value === "bigkey" ? "k".repeat(200) : msg.topic),
  );
  const op = input(node, { topic: "kv:board", payload: 1 });
  assert.equal((await op.result).code, "INVALID_MESSAGE");
  assert.equal(server.calls, 0);
  assert.equal(op.sent.length, 0);
});

test("request history: invalid objects and accessor exceptions are sanitized validation errors", async () => {
  const server = stubServer();
  const node = makeNode("centrifuge-request", { action: "history" }, server);
  for (const payload of [
    new Date(),
    new Map(),
    Buffer.alloc(0),
    { "secret-token": 1 },
    { since: { offset: 0, epoch: "e", "secret-token": 1 } },
    {
      get limit() {
        throw Error("secret-token");
      },
    },
  ]) {
    const err = await input(node, { topic: "news", payload }).result;
    assert.equal(err?.code, "INVALID_MESSAGE");
    assert.doesNotMatch(err.message, /secret-token/);
  }
  assert.equal(server.calls, 0);
});

test("request history: accessor values are validated once and snapshotted", async () => {
  const server = stubServer();
  let reads = 0;
  server.client = { history: async (_channel, opts) => opts };
  const node = makeNode("centrifuge-request", { action: "history" }, server);
  const op = input(node, {
    topic: "news",
    payload: {
      get limit() {
        return ++reads === 1 ? 2 : -1;
      },
    },
  });
  assert.equal(await op.result, undefined);
  assert.equal(reads, 1);
  assert.deepEqual(op.sent[0].payload, { limit: 2 });
});

test("request history: accepts cross-realm objects and rejects malformed options without dispatch", async () => {
  const { runInNewContext } = require("node:vm");
  const server = stubServer();
  const node = makeNode("centrifuge-request", { action: "history" }, server);
  assert.equal(
    await input(node, {
      topic: "news",
      payload: runInNewContext('({limit: 0, since: {offset: 0, epoch: "e"}, reverse: false})'),
    }).result,
    undefined,
  );
  assert.equal(server.calls, 1);
  for (const payload of [
    null,
    [],
    0,
    { limit: -1 },
    { limit: 1.5 },
    { limit: Number.MAX_SAFE_INTEGER + 1 },
    { reverse: "false" },
    { since: [] },
    { since: { offset: -1, epoch: "e" } },
    { since: { offset: 0, epoch: "" } },
  ]) {
    assert.equal((await input(node, { topic: "news", payload }).result).code, "INVALID_MESSAGE");
  }
  server.maxMessageSize = 200;
  assert.equal(
    (await input(node, { topic: "news", payload: { since: { offset: 0, epoch: "e".repeat(200) } } }).result).code,
    "INVALID_MESSAGE",
  );
  assert.equal(server.calls, 1);
});

test("request: invalid imported action and selector fail before I/O", async () => {
  const server = stubServer();
  for (const config of [{ action: "publish" }, { targetType: "num" }, { target: " " }]) {
    const node = makeNode("centrifuge-request", config, server);
    assert.equal(node.statuses.at(-1).fill, "red");
    assert.equal((await input(node, { topic: "echo", payload: null }).result).code, "INVALID_CONFIG");
  }
  assert.equal(server.calls, 0);
});

for (const mode of ["map_publish", "map_remove"]) {
  test(`centrifuge-out ${mode}: preflight covers every SDK command field`, async () => {
    const server = stubServer();
    let calls = 0;
    server.client = {
      mapPublish: async () => {
        calls++;
      },
      mapRemove: async () => {
        calls++;
      },
    };
    const msg = { topic: "kv:board", key: "score", payload: "value" };
    const params = {
      channel: msg.topic,
      type: 1,
      key: msg.key,
      ...(mode === "map_remove" ? { removed: true } : { data: msg.payload }),
    };
    const bytes = Buffer.byteLength(JSON.stringify({ publish: params, id: Number.MAX_SAFE_INTEGER }));
    const node = makeNode("centrifuge-out", { mode }, server, (selector, _type, _node, input, cb) =>
      cb(null, input[selector]),
    );
    server.maxMessageSize = bytes - 1;
    assert.equal((await input(node, { ...msg }).result)?.code, "INVALID_MESSAGE");
    assert.equal(calls, 0);
    server.maxMessageSize = bytes;
    assert.equal(await input(node, { ...msg }).result, undefined);
    assert.equal(calls, 1);
  });
}
