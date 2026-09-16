"use strict";
// Runtime tests for centrifuge-out against a real Node-RED and a real Centrifugo. Each test proves one contract
// line from nodes/centrifuge-out.html. Tests 1-4 share one Node-RED + one Centrifugo (module-level before/after);
// test 5 (timeout while reconnecting) kills its own dedicated Centrifugo and must run last.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { once } = require("node:events");
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

// One raw SDK client subscribed to `channel`, used to observe what actually crosses the wire.
async function observe(channel) {
  const client = new Centrifuge(srv.url, { token: connectionToken({ secret: srv.secret, sub: "observer" }) });
  const sub = client.newSubscription(channel);
  sub.subscribe();
  client.connect();
  await once(sub, "subscribed");
  return { client, sub };
}

// A raw SDK map observer (Centrifugo experimental map subscriptions): "update" carries { key, data } for a set,
// or { key, removed: true } for a removal; a "sync" fires once after subscribe with the current entries.
async function observeMap(channel) {
  const client = new Centrifuge(srv.url, { token: connectionToken({ secret: srv.secret, sub: "observer" }) });
  const sub = client.newMapSubscription(channel);
  sub.subscribe();
  client.connect();
  await once(sub, "subscribed");
  return { client, sub };
}

const server1 = (overrides = {}) => ({
  id: "srv1",
  type: "centrifuge-server",
  url: srv.url,
  auth: "hmac",
  user: "node-red",
  channels: "",
  ttl: 3600,
  timeout: 1000,
  maxMessageSize: 65536,
  credentials: { secret: srv.secret },
  ...overrides,
});
const inject = (id, { topic = "news", topicVt = "str", topicV, payload = "hello", payloadType = "str", wires }) => ({
  id,
  type: "inject",
  z: "f1",
  props: [
    { p: "payload" },
    topicV !== undefined ? { p: "topic", v: topicV, vt: topicVt } : { p: "topic", vt: topicVt },
  ],
  payload,
  payloadType,
  topic,
  wires: [[wires]],
});
const noPayloadInject = (id, { topic = "news", wires }) => ({
  id,
  type: "inject",
  z: "f1",
  props: [{ p: "topic", vt: "str" }],
  topic,
  wires: [[wires]],
});
const debugFull = (id) => ({
  id,
  type: "debug",
  z: "f1",
  active: true,
  tosidebar: true,
  complete: "true",
  targetType: "full",
  wires: [],
});
const catchNode = (scope) => ({ id: "catch1", type: "catch", z: "f1", scope, uncaught: false, wires: [["dbgerr1"]] });
const debugErr = () => ({
  id: "dbgerr1",
  type: "debug",
  z: "f1",
  active: true,
  tosidebar: true,
  complete: "error",
  targetType: "msg",
  wires: [],
});
const tab = () => ({ id: "f1", type: "tab", label: "test" });
// An inject that also sets msg.key (used by the map-mode tests); omit `key` for a message with no key property.
const injectKey = (id, { payload = "1", payloadType = "json", key, wires }) => ({
  id,
  type: "inject",
  z: "f1",
  props: [{ p: "payload" }, ...(key === undefined ? [] : [{ p: "key", v: key, vt: "str" }])],
  payload,
  payloadType,
  wires: [[wires]],
});
const out = (id, overrides = {}) => ({
  id,
  type: "centrifuge-out",
  z: "f1",
  server: "srv1",
  channel: "topic",
  channelType: "msg",
  wires: [["dbg1"]],
  ...overrides,
});

test("out1: happy path, falsy payload matrix, channel selection, permission denied, rejected inputs", async (t) => {
  const flow = [
    server1(),
    inject("inj1", { payload: "hello", payloadType: "str", wires: "out1" }),
    inject("inj2", { payload: "null", payloadType: "json", wires: "out1" }),
    inject("inj3", { payload: "0", payloadType: "num", wires: "out1" }),
    inject("inj4", { payload: "false", payloadType: "bool", wires: "out1" }),
    inject("inj5", { payload: "", payloadType: "str", wires: "out1" }),
    inject("inj6", { payload: "[]", payloadType: "json", wires: "out1" }),
    inject("inj7", { payload: "{}", payloadType: "json", wires: "out1" }),
    inject("inj8", { payload: "[1,2]", payloadType: "bin", wires: "out1" }),
    noPayloadInject("inj9", { wires: "out1" }),
    inject("inj10", { topic: "", wires: "out1" }),
    inject("inj11", { topicVt: "num", topicV: "5", wires: "out1" }),
    inject("inj12", { topic: "locked:x", wires: "out1" }),
    inject("inj13", { topic: "ignored-topic", payload: "viaStr", payloadType: "str", wires: "out2" }),
    out("out1"),
    out("out2", { channel: "news2", channelType: "str", wires: [["dbg2"]] }),
    debugFull("dbg1"),
    debugFull("dbg2"),
    catchNode(["out1", "out2"]),
    debugErr(),
    tab(),
  ];

  const connected = nr.waitForStatus("out1", (s) => s.text === "connected");
  await nr.deploy(flow);
  await connected;

  const observer = await observe("news");
  t.after(() => observer.client.disconnect());

  // (1) happy path
  {
    const pub = once(observer.sub, "publication");
    const dbg = nr.waitForDebug((d) => d.id === "dbg1");
    await nr.inject("inj1");
    const [ctx] = await pub;
    assert.equal(ctx.data, "hello");
    const msg = (await dbg).msg;
    assert.equal(msg.payload, "hello");
    assert.equal(msg.topic, "news");
    assert.deepEqual(msg.centrifuge, { action: "publish", channel: "news" });
  }

  // (2) falsy matrix: observed verbatim on the wire
  for (const [id, expected] of [
    ["inj2", null],
    ["inj3", 0],
    ["inj4", false],
    ["inj5", ""],
    ["inj6", []],
    ["inj7", {}],
  ]) {
    const pub = once(observer.sub, "publication");
    const dbg = nr.waitForDebug((d) => d.id === "dbg1");
    await nr.inject(id);
    const [ctx] = await pub;
    assert.deepEqual(ctx.data, expected, `${id} wire value`);
    const msg = (await dbg).msg;
    assert.deepEqual(msg.payload, expected, `${id} msg.payload`);
  }

  // (3) rejected inputs -> Catch receives INVALID_MESSAGE
  for (const id of ["inj8", "inj9", "inj10", "inj11"]) {
    const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
    await nr.inject(id);
    const err = (await caught).msg;
    assert.equal(err.code, "INVALID_MESSAGE", `${id} code`);
    assert.equal(err.source.id, "out1");
  }

  // (5) permission denied
  {
    const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
    await nr.inject("inj12");
    const err = (await caught).msg;
    assert.equal(err.code, "PERMISSION_DENIED");
    assert.match(err.message, /103/);
  }

  // (4) channel from a str TypedInput ignores msg.topic
  {
    const observer2 = await observe("news2");
    t.after(() => observer2.client.disconnect());
    const pub = once(observer2.sub, "publication");
    const dbg = nr.waitForDebug((d) => d.id === "dbg2");
    await nr.inject("inj13");
    const [ctx] = await pub;
    assert.equal(ctx.data, "viaStr");
    const msg = (await dbg).msg;
    assert.equal(msg.topic, "ignored-topic"); // preserved on the message, but not used as the channel
    assert.deepEqual(msg.centrifuge, { action: "publish", channel: "news2" });
  }
});

test("out1: oversize command is refused locally; the connection survives for the next publish", async () => {
  const flow = [
    server1({ maxMessageSize: 200 }),
    inject("injBig", { payload: "x".repeat(300), payloadType: "str", wires: "out1" }),
    inject("injSmall", { payload: "hi", payloadType: "str", wires: "out1" }),
    out("out1"),
    debugFull("dbg1"),
    catchNode(["out1"]),
    debugErr(),
    tab(),
  ];
  const connected = nr.waitForStatus("out1", (s) => s.text === "connected");
  await nr.deploy(flow);
  await connected;

  const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
  await nr.inject("injBig");
  const err = (await caught).msg;
  assert.equal(err.code, "INVALID_MESSAGE");

  const dbg = nr.waitForDebug((d) => d.id === "dbg1");
  await nr.inject("injSmall");
  const msg = (await dbg).msg;
  assert.equal(msg.payload, "hi"); // the connection was not killed by the refused oversize command
});

test("out1: missing server config shows a red status and fails via MISSING_SERVER", async () => {
  const flow = [
    inject("inj1", { wires: "out1" }),
    out("out1", { server: "" }),
    debugFull("dbg1"),
    catchNode(["out1"]),
    debugErr(),
    tab(),
  ];
  const missing = nr.waitForStatus("out1", (s) => s.text === "missing server");
  await nr.deploy(flow);
  await missing;
  const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
  await nr.inject("inj1");
  const err = (await caught).msg;
  assert.equal(err.code, "MISSING_SERVER");
});

test("out1: modified-node redeploy preserves the package sibling subscription and connection identity", async () => {
  const flow = [
    server1(),
    inject("inj1", { wires: "out1" }),
    out("out1"),
    debugFull("dbg1"),
    {
      id: "in1",
      type: "centrifuge-in",
      z: "f1",
      server: "srv1",
      mode: "subscribe",
      channel: "news",
      wires: [["dbgin"]],
    },
    debugFull("dbgin"),
    tab(),
  ];
  const subscribed = nr.waitForStatus("in1", (s) => s.text === "subscribed");
  await nr.deploy(flow);
  await subscribed;
  const before = await srv.api("presence", { channel: "news" });
  const modified = (await nr.api("GET", "/flows")).map((n) => (n.id === "out1" ? { ...n, name: "renamed" } : n));
  await nr.deploy(modified, "nodes");
  const pub = nr.waitForDebug((d) => d.id === "dbgin");
  const ack = nr.waitForDebug((d) => d.id === "dbg1");
  await nr.inject("inj1");
  assert.equal((await pub).msg.payload, "hello");
  await ack;
  assert.deepEqual(
    await srv.api("presence", { channel: "news" }),
    before,
    "same subscriber client ID after partial deploy",
  );
});

test("out1: invalid server configuration fails before payload processing", async () => {
  const invalid = nr.waitForLog(/centrifuge-out:out1.*invalid config/, { after: nr.lines.length });
  await nr.deploy([
    server1({ timeout: null }),
    inject("inj1", { wires: "out1" }),
    out("out1"),
    catchNode(["out1"]),
    debugErr(),
    tab(),
  ]);
  await invalid;
  const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
  await nr.inject("inj1");
  assert.equal((await caught).msg.code, "INVALID_CONFIG");
});

test("out1: stalled asynchronous context lookup times out and does not block partial redeploy", async (t) => {
  const contextNr = await startNodeRed({
    packageDir,
    settingsModule: path.resolve(__dirname, "../fixtures/stalled-settings.js"),
  });
  t.after(() => contextNr.stop());
  const flow = (timeout) => [
    server1({ timeout }),
    inject("inj1", { wires: "out1" }),
    out("out1", { channelType: "global", channel: "#:(stalled)::channel" }),
    catchNode(["out1"]),
    debugErr(),
    tab(),
  ];
  await contextNr.deploy(flow(100));
  const caught = contextNr.waitForDebug((d) => d.id === "dbgerr1");
  await contextNr.inject("inj1");
  assert.equal((await caught).msg.code, "TIMEOUT");
  await contextNr.deploy(flow(60000));
  const entered = contextNr.waitForLog(/stalled context read/, { after: contextNr.lines.length });
  await contextNr.inject("inj1");
  await entered;
  const start = performance.now();
  const beforeClose = contextNr.lines.length;
  await contextNr.deploy(
    (await contextNr.api("GET", "/flows")).map((n) => (n.id === "out1" ? { ...n, name: "renamed" } : n)),
    "nodes",
  );
  assert.ok(performance.now() - start < 2000, "close cancels evaluation before Node-RED's close timeout");
  assert.ok(!contextNr.lines.slice(beforeClose).some((line) => /Error stopping node|node is closing/.test(line)));
});

test("out1: map publish/remove, permission denial, missing key, str-typed key selector", async (t) => {
  const flow = [
    server1(),
    injectKey("injMapPub", { payload: "42", payloadType: "num", key: "score", wires: "outMapPub" }),
    injectKey("injMapRemove", { key: "score", wires: "outMapRemove" }),
    injectKey("injRo", { key: "score", wires: "outRo" }),
    injectKey("injMissingKey", { wires: "outMissingKey" }),
    injectKey("injEmptyKey", { key: "", wires: "outMissingKey" }),
    injectKey("injStrKey", { payload: "viaStrKey", payloadType: "str", wires: "outStrKey" }),
    out("outMapPub", { channel: "kv:board", channelType: "str", mode: "map_publish", wires: [["dbg1"]] }),
    out("outMapRemove", { channel: "kv:board", channelType: "str", mode: "map_remove", wires: [["dbg1"]] }),
    out("outRo", { channel: "ro:board", channelType: "str", mode: "map_publish", wires: [["dbg1"]] }),
    out("outMissingKey", { channel: "kv:board", channelType: "str", mode: "map_publish", wires: [["dbg1"]] }),
    out("outStrKey", {
      channel: "kv:board",
      channelType: "str",
      mode: "map_publish",
      key: "fixedKey",
      keyType: "str",
      wires: [["dbg1"]],
    }),
    debugFull("dbg1"),
    catchNode(["outMapPub", "outMapRemove", "outRo", "outMissingKey", "outStrKey"]),
    debugErr(),
    tab(),
  ];
  const connected = nr.waitForStatus("outMapPub", (s) => s.text === "connected");
  await nr.deploy(flow);
  await connected;

  const observer = await observeMap("kv:board");
  t.after(() => observer.client.disconnect());

  // (1) map_publish reaches a raw map observer as an update with the key/data, and forwards msg.centrifuge
  {
    const upd = once(observer.sub, "update");
    const dbg = nr.waitForDebug((d) => d.id === "dbg1");
    await nr.inject("injMapPub");
    const [ctx] = await upd;
    assert.equal(ctx.key, "score");
    assert.equal(ctx.data, 42);
    const msg = (await dbg).msg;
    assert.deepEqual(msg.centrifuge, { action: "map_publish", channel: "kv:board", key: "score" });
  }

  // (2) map_remove reaches the observer as an update with removed: true, and forwards msg.centrifuge
  {
    const upd = once(observer.sub, "update");
    const dbg = nr.waitForDebug((d) => d.id === "dbg1");
    await nr.inject("injMapRemove");
    const [ctx] = await upd;
    assert.equal(ctx.key, "score");
    assert.equal(ctx.removed, true);
    const msg = (await dbg).msg;
    assert.deepEqual(msg.centrifuge, { action: "map_remove", channel: "kv:board", key: "score" });
  }

  // (3) a read-only map namespace refuses the write with PERMISSION_DENIED (server code 103)
  {
    const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
    await nr.inject("injRo");
    const err = (await caught).msg;
    assert.equal(err.code, "PERMISSION_DENIED");
    assert.match(err.message, /103/);
  }

  // (4) missing/empty key fails locally with INVALID_MESSAGE; nothing is written
  for (const id of ["injMissingKey", "injEmptyKey"]) {
    const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
    const noUpdate = assert.rejects(once(observer.sub, "update", { signal: AbortSignal.timeout(300) }));
    await nr.inject(id);
    const err = (await caught).msg;
    assert.equal(err.code, "INVALID_MESSAGE", id);
    assert.match(err.message, /key/, id);
    await noUpdate;
  }

  // (5) a str-typed key selector ignores msg.key and still writes the configured key
  {
    const upd = once(observer.sub, "update");
    const dbg = nr.waitForDebug((d) => d.id === "dbg1");
    await nr.inject("injStrKey");
    const [ctx] = await upd;
    assert.equal(ctx.key, "fixedKey");
    assert.equal(ctx.data, "viaStrKey");
    const msg = (await dbg).msg;
    assert.deepEqual(msg.centrifuge, { action: "map_publish", channel: "kv:board", key: "fixedKey" });
  }
});

test("out1: timeout while reconnecting fails with TIMEOUT within the configured deadline", async (t) => {
  const srv2 = await startCentrifugo();
  t.after(() => srv2.stop());

  const flow = [
    server1({ url: srv2.url, timeout: 1000 }),
    inject("inj1", { wires: "out1" }),
    out("out1"),
    debugFull("dbg1"),
    catchNode(["out1"]),
    debugErr(),
    tab(),
  ];
  const connected = nr.waitForStatus("out1", (s) => s.text === "connected");
  await nr.deploy(flow);
  await connected;

  const connecting = nr.waitForStatus("out1", (s) => s.text === "connecting");
  srv2.child.kill("SIGKILL");
  await connecting;

  const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
  const start = Date.now();
  await nr.inject("inj1");
  const err = (await caught).msg;
  const elapsed = Date.now() - start;
  assert.equal(err.code, "TIMEOUT");
  assert.ok(elapsed >= 900 && elapsed < 3000, `elapsed was ${elapsed}ms`);
});

test("map removal at the old preflight boundary is rejected and the connection stays usable", async () => {
  const flow = [
    server1({ maxMessageSize: 1024 }),
    injectKey("injLarge", { key: "k".repeat(956), wires: "remove1" }),
    injectKey("injSmall", { key: "score", wires: "remove1" }),
    out("remove1", { mode: "map_remove", channel: "kv:board", channelType: "str", wires: [["dbg1"]] }),
    debugFull("dbg1"),
    catchNode(["remove1"]),
    debugErr(),
    tab(),
  ];
  const connected = nr.waitForStatus("remove1", (s) => s.text === "connected");
  await nr.deploy(flow);
  await connected;
  const refused = nr.waitForDebug((d) => d.id === "dbgerr1");
  await nr.inject("injLarge");
  assert.equal((await refused).msg.code, "INVALID_MESSAGE");
  const ack = nr.waitForDebug((d) => d.id === "dbg1");
  await nr.inject("injSmall");
  assert.deepEqual((await ack).msg.centrifuge, { action: "map_remove", channel: "kv:board", key: "score" });
});
