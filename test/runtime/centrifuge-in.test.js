"use strict";
// Runtime tests for `centrifuge in` against a real Node-RED and a real Centrifugo. One server/runtime pair is
// shared across every test in this file (see the shared "reuse one Node-RED + one Centrifugo" guidance); each test
// deploys its own flow. Each test proves one contract line from nodes/centrifuge-in.html.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Centrifuge } = require("centrifuge");
const { startNodeRed } = require("../helpers/node-red");
const { startCentrifugo } = require("../helpers/centrifugo");
const { connectionToken } = require("../../lib/jwt");

const packageDir = path.resolve(__dirname, "../..");

let srv, nr;
test.before(async () => {
  srv = await startCentrifugo();
  nr = await startNodeRed({ packageDir });
});
test.after(async () => {
  await nr.stop();
  await srv.stop();
});

const tab = { id: "f1", type: "tab", label: "test" };
const server = (channels = "") => ({
  id: "srv1",
  type: "centrifuge-server",
  url: srv.url,
  auth: "hmac",
  user: "node-red",
  channels,
  ttl: 3600,
  timeout: 2000,
  maxMessageSize: 65536,
  credentials: { secret: srv.secret },
});
const inNode = (id, wires, overrides = {}) => ({
  id,
  type: "centrifuge-in",
  z: "f1",
  name: "",
  server: "srv1",
  mode: "subscribe",
  channel: "",
  joinLeave: false,
  subscriptionAuth: "none",
  ...overrides,
  wires: [wires],
});
const dbg = (id) => ({
  id,
  type: "debug",
  z: "f1",
  active: true,
  tosidebar: true,
  complete: "true",
  targetType: "full",
  wires: [],
});

test("subscribe mode: status, publication fields, and falsy payloads arrive verbatim", async () => {
  const subscribed = nr.waitForStatus("in1", (s) => s.text === "subscribed");
  await nr.deploy([tab, server(), inNode("in1", ["dbg1"], { channel: "news" }), dbg("dbg1")]);
  await subscribed;

  const got = nr.waitForDebug((d) => d.id === "dbg1");
  await srv.api("publish", { channel: "news", data: { hello: 1 } });
  const msg = (await got).msg;
  assert.deepEqual(msg.payload, { hello: 1 });
  assert.equal(msg.topic, "news");
  assert.equal(msg.centrifuge.event, "publication");
  assert.equal(msg.centrifuge.channel, "news");
  assert.equal(typeof msg.centrifuge.offset, "number");

  for (const value of [null, 0, false, "", [], {}]) {
    const next = nr.waitForDebug((d) => d.id === "dbg1");
    await srv.api("publish", { channel: "news", data: value });
    assert.deepEqual((await next).msg.payload, value, `falsy payload ${JSON.stringify(value)} survives`);
  }
});

test("two in nodes share one subscription; each receives its own message", async () => {
  const s1 = nr.waitForStatus("in1", (s) => s.text === "subscribed");
  const s2 = nr.waitForStatus("in2", (s) => s.text === "subscribed");
  await nr.deploy([
    tab,
    server(),
    inNode("in1", ["dbg1"], { channel: "news" }),
    inNode("in2", ["dbg2"], { channel: "news" }),
    dbg("dbg1"),
    dbg("dbg2"),
  ]);
  await Promise.all([s1, s2]);

  const w1 = nr.waitForDebug((d) => d.id === "dbg1");
  const w2 = nr.waitForDebug((d) => d.id === "dbg2");
  await srv.api("publish", { channel: "news", data: { n: 1 } });
  const [m1, m2] = await Promise.all([w1, w2]);
  assert.deepEqual(m1.msg.payload, { n: 1 });
  assert.deepEqual(m2.msg.payload, { n: 1 });
});

test("modified-node redeploy: renaming in1 leaves in2 running; removing in1 leaves in2 receiving", async () => {
  const base = [
    tab,
    server(),
    inNode("in1", ["dbg1"], { channel: "news" }),
    inNode("in2", ["dbg2"], { channel: "news" }),
    dbg("dbg1"),
    dbg("dbg2"),
  ];
  const ready = Promise.all([
    nr.waitForStatus("in1", (s) => s.text === "subscribed"),
    nr.waitForStatus("in2", (s) => s.text === "subscribed"),
  ]);
  await nr.deploy(base);
  await ready;
  const presence = await srv.api("presence", { channel: "news" });

  // in2 must never go red across a redeploy that only touches in1
  const in2StaysUp = assert.rejects(nr.waitForStatus("in2", (s) => s.fill === "red", 3000));

  const renamed = (await nr.api("GET", "/flows")).map((n) => (n.id === "in1" ? { ...n, name: "renamed" } : n));
  await nr.deploy(renamed, "nodes");

  const afterRename1 = nr.waitForDebug((d) => d.id === "dbg1");
  const afterRename2 = nr.waitForDebug((d) => d.id === "dbg2");
  await srv.api("publish", { channel: "news", data: { n: 2 } });
  assert.deepEqual((await afterRename1).msg.payload, { n: 2 });
  assert.deepEqual((await afterRename2).msg.payload, { n: 2 });
  await in2StaysUp;
  assert.deepEqual(await srv.api("presence", { channel: "news" }), presence);

  const withoutIn1 = renamed.filter((n) => n.id !== "in1");
  await nr.deploy(withoutIn1, "nodes");
  const afterRemove2 = nr.waitForDebug((d) => d.id === "dbg2");
  await srv.api("publish", { channel: "news", data: { n: 3 } });
  assert.deepEqual((await afterRemove2).msg.payload, { n: 3 });
});

test("locked channel: subscription is refused with permission denied (103)", async () => {
  const denied = nr.waitForStatus("in1", (s) => s.text === "unsubscribed: permission denied (103)");
  await nr.deploy([tab, server(), inNode("in1", ["dbg1"], { channel: "locked:x" }), dbg("dbg1")]);
  await denied;
});

test("server mode: granted channel subscribes and is exact-match filtered, ungranted awaits, conflict with subscribe mode", async () => {
  const subscribed = nr.waitForStatus("in1", (s) => s.text === "subscribed");
  const awaiting = nr.waitForStatus("in2", (s) => s.text === "awaiting server subscription");
  const conflict = nr.waitForStatus("in3", (s) => s.text === "conflict: channel is server-side");
  await nr.deploy([
    tab,
    server("news\nalerts"),
    inNode("in1", ["dbg1"], { mode: "server", channel: "news" }),
    inNode("in2", ["dbg2"], { mode: "server", channel: "nope" }),
    inNode("in3", ["dbg3"], { mode: "subscribe", channel: "news" }),
    dbg("dbg1"),
    dbg("dbg2"),
    dbg("dbg3"),
  ]);
  await Promise.all([subscribed, awaiting, conflict]);

  const gotNews = nr.waitForDebug((d) => d.id === "dbg1");
  await srv.api("publish", { channel: "news", data: { n: 1 } });
  assert.deepEqual((await gotNews).msg.payload, { n: 1 });

  const noAlerts = assert.rejects(nr.waitForDebug((d) => d.id === "dbg1", 2000));
  await srv.api("publish", { channel: "alerts", data: { n: 2 } });
  await noAlerts;
});

test("joinLeave: opted-in node gets join then leave, sibling without it gets neither", async () => {
  const s1 = nr.waitForStatus("in1", (s) => s.text === "subscribed");
  const s2 = nr.waitForStatus("in2", (s) => s.text === "subscribed");
  await nr.deploy([
    tab,
    server(),
    inNode("in1", ["dbg1"], { channel: "room", joinLeave: true }),
    inNode("in2", ["dbg2"], { channel: "room", joinLeave: false }),
    dbg("dbg1"),
    dbg("dbg2"),
  ]);
  await Promise.all([s1, s2]);

  const join = nr.waitForDebug((d) => d.id === "dbg1" && d.msg?.centrifuge?.event === "join");
  const noJoinLeaveOnSibling = assert.rejects(
    nr.waitForDebug((d) => d.id === "dbg2" && d.msg?.centrifuge?.event !== "publication", 3000),
  );

  const other = new Centrifuge(srv.url, { token: connectionToken({ secret: srv.secret, sub: "other" }) });
  other.connect();
  const sub = other.newSubscription("room");
  sub.subscribe();

  const joinMsg = (await join).msg;
  assert.equal(joinMsg.centrifuge.event, "join");
  assert.equal(joinMsg.centrifuge.channel, "room");
  assert.equal(joinMsg.payload.user, "other");

  const leave = nr.waitForDebug((d) => d.id === "dbg1" && d.msg?.centrifuge?.event === "leave");
  sub.unsubscribe();
  const leaveMsg = (await leave).msg;
  assert.equal(leaveMsg.centrifuge.event, "leave");
  assert.equal(leaveMsg.payload.user, "other");

  await noJoinLeaveOnSibling;
  other.disconnect();
});

test("map mode: sync carries the seeded snapshot, then per-key update and removal", async () => {
  await srv.api("map_publish", { channel: "kv:sync-test", key: "a", data: { n: 1 } });
  await srv.api("map_publish", { channel: "kv:sync-test", key: "b", data: { n: 2 } });

  const first = nr.waitForDebug((d) => d.id === "dbg1");
  await nr.deploy([tab, server(), inNode("in1", ["dbg1"], { mode: "map", channel: "kv:sync-test" }), dbg("dbg1")]);
  const syncMsg = (await first).msg;
  assert.equal(syncMsg.topic, "kv:sync-test");
  assert.equal(syncMsg.centrifuge.event, "sync");
  assert.equal(syncMsg.centrifuge.channel, "kv:sync-test");
  assert.deepEqual(syncMsg.payload.map((e) => [e.key, e.data]).sort(), [
    ["a", { n: 1 }],
    ["b", { n: 2 }],
  ]);

  const updated = nr.waitForDebug((d) => d.id === "dbg1" && d.msg?.centrifuge?.event === "update");
  await srv.api("map_publish", { channel: "kv:sync-test", key: "c", data: { n: 3 } });
  const updateMsg = (await updated).msg;
  assert.deepEqual(updateMsg.payload, { n: 3 });
  assert.equal(updateMsg.centrifuge.key, "c");
  assert.equal(updateMsg.centrifuge.removed, undefined);

  const removed = nr.waitForDebug(
    (d) => d.id === "dbg1" && d.msg?.centrifuge?.event === "update" && d.msg.centrifuge.key === "a",
  );
  await srv.api("map_remove", { channel: "kv:sync-test", key: "a" });
  const removeMsg = (await removed).msg;
  assert.equal(removeMsg.payload, null);
  assert.equal(removeMsg.centrifuge.removed, true);
});

test("map mode: two in nodes on the same channel both receive the update", async () => {
  const s1 = nr.waitForStatus("in1", (s) => s.text === "subscribed");
  const s2 = nr.waitForStatus("in2", (s) => s.text === "subscribed");
  await nr.deploy([
    tab,
    server(),
    inNode("in1", ["dbg1"], { mode: "map", channel: "kv:shared" }),
    inNode("in2", ["dbg2"], { mode: "map", channel: "kv:shared" }),
    dbg("dbg1"),
    dbg("dbg2"),
  ]);
  await Promise.all([s1, s2]);

  const w1 = nr.waitForDebug((d) => d.id === "dbg1" && d.msg?.centrifuge?.event === "update");
  const w2 = nr.waitForDebug((d) => d.id === "dbg2" && d.msg?.centrifuge?.event === "update");
  await srv.api("map_publish", { channel: "kv:shared", key: "x", data: 1 });
  const [m1, m2] = await Promise.all([w1, w2]);
  assert.equal(m1.msg.payload, 1);
  assert.equal(m2.msg.payload, 1);
});

test("map mode vs subscribe mode on the same channel: the second deployed node shows the type-conflict status", async () => {
  const s1 = nr.waitForStatus("in1", (s) => s.text === "subscribed");
  const conflict = nr.waitForStatus(
    "in2",
    (s) => s.text === "invalid config: subscription type differs from the existing subscription",
  );
  await nr.deploy([
    tab,
    server(),
    inNode("in1", ["dbg1"], { mode: "map", channel: "kv:conflict" }),
    inNode("in2", ["dbg2"], { mode: "subscribe", channel: "kv:conflict" }),
    dbg("dbg1"),
    dbg("dbg2"),
  ]);
  await Promise.all([s1, conflict]);
});

test("map mode on a stream namespace is refused with permission denied (103)", async () => {
  const denied = nr.waitForStatus("in1", (s) => s.text === "unsubscribed: permission denied (103)");
  await nr.deploy([tab, server(), inNode("in1", ["dbg1"], { mode: "map", channel: "news" }), dbg("dbg1")]);
  await denied;
});

test("map_clients: presence updates as a raw client joins and leaves", async () => {
  const synced = nr.waitForDebug((d) => d.id === "dbg1" && d.msg?.centrifuge?.event === "sync");
  await nr.deploy([
    tab,
    server(),
    inNode("in1", ["dbg1"], { mode: "map_clients", channel: "clients:games:lobby" }),
    dbg("dbg1"),
  ]);
  assert.deepEqual((await synced).msg.payload, []);

  let clientId;
  const other = new Centrifuge(srv.url, { token: connectionToken({ secret: srv.secret, sub: "presence-user" }) });
  other.on("connected", (ctx) => {
    clientId = ctx.client;
  });
  const joined = nr.waitForDebug((d) => d.id === "dbg1" && d.msg?.centrifuge?.event === "update");
  other.connect();
  const sub = other.newSubscription("games:lobby");
  sub.subscribe();
  const joinMsg = (await joined).msg;
  assert.equal(joinMsg.centrifuge.key, clientId);
  assert.equal(joinMsg.payload.user, "presence-user");

  const left = nr.waitForDebug(
    (d) => d.id === "dbg1" && d.msg?.centrifuge?.event === "update" && d.msg.centrifuge.removed === true,
  );
  sub.unsubscribe();
  const leaveMsg = (await left).msg;
  assert.equal(leaveMsg.payload, null);
  assert.equal(leaveMsg.centrifuge.key, clientId);
  other.disconnect();
});

test("missing server: status is 'missing server'", async () => {
  const missing = nr.waitForStatus("in1", (s) => s.text === "missing server");
  await nr.deploy([tab, { id: "in1", type: "centrifuge-in", z: "f1", server: "", mode: "subscribe", wires: [[]] }]);
  await missing;
});

test("partial redeploy replays the map snapshot to the replaced node and keeps its sibling live", async () => {
  const channel = "kv:redeploy-snapshot";
  await srv.api("map_publish", { channel, key: "seed", data: { n: 1 } });
  const flow = [
    tab,
    server(),
    inNode("in1", ["dbg1"], { mode: "map", channel }),
    inNode("in2", ["dbg2"], { mode: "map", channel }),
    dbg("dbg1"),
    dbg("dbg2"),
  ];
  const initial = nr.waitForDebug((d) => d.id === "dbg1" && d.msg?.centrifuge?.event === "sync");
  const sibling = nr.waitForDebug((d) => d.id === "dbg2" && d.msg?.centrifuge?.event === "sync");
  await nr.deploy(flow);
  await Promise.all([initial, sibling]);
  const changed = nr.waitForDebug((d) => d.id === "dbg2" && d.msg?.centrifuge?.event === "update");
  await srv.api("map_publish", { channel, key: "seed", data: { n: 2 } });
  await changed;
  const replay = nr.waitForDebug((d) => d.id === "dbg1" && d.msg?.centrifuge?.event === "sync");
  const modified = (await nr.api("GET", "/flows")).map((n) => (n.id === "in1" ? { ...n, name: "renamed" } : n));
  await nr.deploy(modified, "nodes");
  assert.deepEqual(
    (await replay).msg.payload.map((e) => [e.key, e.data]),
    [["seed", { n: 2 }]],
  );
  const first = nr.waitForDebug((d) => d.id === "dbg1" && d.msg?.centrifuge?.event === "update");
  const second = nr.waitForDebug((d) => d.id === "dbg2" && d.msg?.centrifuge?.event === "update");
  await srv.api("map_remove", { channel, key: "seed" });
  for (const result of await Promise.all([first, second])) assert.equal(result.msg.centrifuge.removed, true);
});
