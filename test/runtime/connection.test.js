"use strict";
// lib/connection.js against a real Centrifugo (no Node-RED): the frozen interface the nodes build on.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Centrifuge } = require("centrifuge");
const { startCentrifugo } = require("../helpers/centrifugo");
const { createConnection } = require("../../lib/connection");
const { connectionToken } = require("../../lib/jwt");

// Records pushed statuses/events and lets a test await the first one matching a predicate (no polling).
function recorder() {
  const seen = [];
  const waiters = new Set();
  const push = (item) => {
    seen.push(item);
    for (const w of waiters) if (w.pred(item)) w.resolve(item);
  };
  const until = async (pred, ms = 5000) => {
    const hit = seen.find(pred);
    if (hit) return hit;
    const w = { ...Promise.withResolvers(), pred };
    waiters.add(w);
    const timer = setTimeout(
      () => w.reject(new Error(`timed out; seen: ${seen.map((s) => s.text ?? s.event).join(", ")}`)),
      ms,
    ); // allow-timer: deadline, cleared on every settle path
    try {
      return await w.promise;
    } finally {
      clearTimeout(timer);
      waiters.delete(w);
    }
  };
  return { seen, push, until };
}
const consumer = (joinLeave) => {
  const status = recorder();
  const events = recorder();
  return { joinLeaveWanted: joinLeave, status, events, onStatus: status.push, onEvent: events.push };
};

test("hmac connect, shared subscription fan-out, refcount dispose, run publish, close", async (t) => {
  const srv = await startCentrifugo();
  t.after(() => srv.stop());
  const status = recorder();
  const conn = createConnection({ url: srv.url, secret: srv.secret });
  conn.onStatus(status.push);
  conn.connect();
  await status.until((s) => s.text === "connected");
  const a = consumer(false);
  const b = consumer(false);
  const disposeA = conn.subscribe("news", a);
  const disposeB = conn.subscribe("news", b);
  await a.status.until((s) => s.text === "subscribed");
  await b.status.until((s) => s.text === "subscribed");
  assert.equal(conn.client.subscriptions().news !== undefined, true, "one SDK subscription for two consumers");

  const result = await conn.run((client) => client.publish("news", { n: 1 }));
  assert.deepEqual(result, {}, "client publish acknowledgement carries no position");
  const pubA = await a.events.until((e) => e.event === "publication");
  const pubB = await b.events.until((e) => e.event === "publication");
  assert.deepEqual(pubA.data, { n: 1 });
  assert.equal(pubA.channel, "news");
  assert.equal(typeof pubA.offset, "number");
  assert.deepEqual(pubB.data, { n: 1 });

  disposeA();
  disposeA(); // idempotent
  await conn.run((client) => client.publish("news", { n: 2 }));
  await b.events.until((e) => e.event === "publication" && e.data.n === 2);
  assert.equal(a.events.seen.filter((e) => e.data?.n === 2).length, 0, "disposed consumer receives nothing");
  disposeB();
  assert.equal(conn.client.getSubscription("news"), null, "last consumer removes the SDK subscription");

  const before = process.getActiveResourcesInfo().length;
  conn.close();
  assert.equal(conn.closing, true);
  await assert.rejects(
    conn.run(() => {}),
    (e) => e.code === "CLOSING",
  );
  assert.throws(
    () => conn.subscribe("x", consumer(false)),
    (e) => e.code === "CLOSING",
  );
  assert.ok(process.getActiveResourcesInfo().length <= before, "close adds no handles");
});

test("static token and anonymous auth connect; wrong secret is terminal and run() fails fast", async (t) => {
  const srv = await startCentrifugo({ config: { client: { allow_anonymous_connect_without_token: true } } });
  t.after(() => srv.stop());
  for (const opts of [
    { url: srv.url, auth: "token", token: connectionToken({ secret: srv.secret, sub: "static" }) },
    { url: srv.url, auth: "none" },
  ]) {
    const status = recorder();
    const conn = createConnection(opts);
    conn.onStatus(status.push);
    conn.connect();
    await status.until((s) => s.text === "connected");
    conn.close();
  }
  const status = recorder();
  const bad = createConnection({ url: srv.url, secret: "not-the-secret", timeout: 3000 });
  bad.onStatus(status.push);
  bad.connect();
  const terminal = await status.until((s) => s.terminal === true);
  assert.equal(terminal.text, "disconnected: invalid token (3500)");
  const started = performance.now();
  await assert.rejects(
    bad.run((client) => client.publish("news", 1)),
    (e) => e.code === "NOT_CONNECTED" && /invalid token/.test(e.message),
  );
  assert.ok(performance.now() - started < 500, "terminal connection fails fast, not after the timeout");
  bad.close();
});

test("permissions: locked channel shows unsubscribed 103; publish maps to PERMISSION_DENIED; size preflight is the caller's", async (t) => {
  const srv = await startCentrifugo();
  t.after(() => srv.stop());
  const conn = createConnection({ url: srv.url, secret: srv.secret });
  t.after(() => conn.close());
  conn.connect();
  const c = consumer(false);
  conn.subscribe("locked:x", c);
  const s = await c.status.until((x) => x.terminal === true);
  assert.equal(s.text, "unsubscribed: permission denied (103)");
  await assert.rejects(
    conn.run((client) => client.publish("locked:x", 1)),
    (e) => e.code === "PERMISSION_DENIED" && e.centrifuge.code === 103 && e.centrifuge.temporary === false,
  );
  assert.equal(conn.maxMessageSize, 65536);
});

test("server-side subscriptions: channels claim, filter status, conflict with a local subscribe", async (t) => {
  const srv = await startCentrifugo();
  t.after(() => srv.stop());
  const conn = createConnection({ url: srv.url, secret: srv.secret, channels: "news\nalerts\n" });
  t.after(() => conn.close());
  const all = consumer(false);
  const news = { ...consumer(false), channel: "news" };
  const missing = { ...consumer(false), channel: "not-granted" };
  conn.onServerSide(all);
  conn.onServerSide(news);
  conn.onServerSide(missing);
  conn.connect();
  await news.status.until((s) => s.text === "subscribed");
  await missing.status.until((s) => s.text === "awaiting server subscription");
  await all.status.until((s) => s.text === "connected");
  await srv.api("publish", { channel: "news", data: "hi" });
  await srv.api("publish", { channel: "alerts", data: "boo" });
  const got = await news.events.until((e) => e.event === "publication" && e.channel === "news");
  assert.equal(got.data, "hi");
  await all.events.until((e) => e.event === "publication" && e.channel === "alerts");
  assert.equal(
    all.events.seen.some((e) => e.event !== "publication"),
    false,
    "server-mode join/leave need joinLeave",
  );
  assert.equal(
    news.events.seen.some((e) => e.channel === "alerts"),
    false,
    "filter is exact",
  );
  assert.throws(
    () => conn.subscribe("news", consumer(false)),
    (e) => e.code === "CONFIG_CONFLICT",
  );
});

test("joinLeave: union across consumers with per-consumer filtering; upgrade recreates the subscription", async (t) => {
  const srv = await startCentrifugo();
  t.after(() => srv.stop());
  const conn = createConnection({ url: srv.url, secret: srv.secret });
  t.after(() => conn.close());
  conn.connect();
  const plain = consumer(false);
  const watcher = consumer(true);
  conn.subscribe("room", plain);
  await plain.status.until((s) => s.text === "subscribed");
  const firstSub = conn.client.getSubscription("room");
  conn.subscribe("room", watcher, { joinLeave: true });
  await watcher.status.until((s) => s.text === "subscribed");
  assert.notEqual(conn.client.getSubscription("room"), firstSub, "upgrade recreated the SDK subscription");
  assert.equal(conn.client.getSubscription("room").options?.joinLeave ?? true, true);

  const other = new Centrifuge(srv.url, { token: connectionToken({ secret: srv.secret, sub: "other" }) });
  t.after(() => other.disconnect());
  other.connect();
  const sub = other.newSubscription("room");
  sub.subscribe();
  const join = await watcher.events.until((e) => e.event === "join" && e.info?.user === "other");
  assert.equal(join.channel, "room");
  sub.unsubscribe();
  await watcher.events.until((e) => e.event === "leave" && e.info?.user === "other");
  assert.equal(
    plain.events.seen.filter((e) => e.event !== "publication").length,
    0,
    "consumer without joinLeave gets none",
  );
});
