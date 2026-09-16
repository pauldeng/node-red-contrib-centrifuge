"use strict";
// Runtime tests for centrifuge-request against a real Node-RED, a real Centrifugo, and a real RPC proxy backend.
// Each test proves one contract line from nodes/centrifuge-request.html. One Node-RED + one Centrifugo + one RPC
// backend are shared (module-level before/after); the "rpc without a proxy" test needs a second Centrifugo.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { once } = require("node:events");
const { Centrifuge } = require("centrifuge");
const { startNodeRed } = require("../helpers/node-red");
const { startCentrifugo, baseConfig, merge } = require("../helpers/centrifugo");
const { startRpcBackend } = require("../helpers/rpc-backend");
const { connectionToken } = require("../../lib/jwt");

const packageDir = path.resolve(__dirname, "../..");

let srv, nr, backend;
test.before(async () => {
  backend = await startRpcBackend();
  // "noperm" has history/presence enabled but not for clients, to observe real PERMISSION_DENIED (103) responses,
  // on top of the fixture's own "locked" (nothing enabled -> 108) and an undefined namespace (-> 102).
  const namespaces = [
    ...baseConfig(0).channel.namespaces,
    {
      name: "noperm",
      allow_subscribe_for_client: true,
      presence: true,
      history_size: 10,
      history_ttl: "60s",
      allow_history_for_client: false,
      allow_presence_for_client: false,
    },
  ];
  srv = await startCentrifugo({ config: merge(backend.config, { channel: { namespaces } }) });
  nr = await startNodeRed({ packageDir });
});
test.after(async () => {
  try {
    await nr?.stop();
  } finally {
    try {
      await srv?.stop();
    } finally {
      await backend?.stop();
    }
  }
});

// One raw SDK client subscribed to `channel`, used to be a presence entry the request node can observe.
async function observe(t, channel) {
  const client = new Centrifuge(srv.url, { token: connectionToken({ secret: srv.secret, sub: "observer" }) });
  const sub = client.newSubscription(channel);
  t.after(() => client.disconnect());
  const subscribed = once(sub, "subscribed", { signal: AbortSignal.timeout(5000) });
  sub.subscribe();
  client.connect();
  await subscribed;
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
  timeout: 2000,
  maxMessageSize: 65536,
  credentials: { secret: srv.secret },
  ...overrides,
});
const inject = (id, { topic, payload, payloadType = "json", wires }) => ({
  id,
  type: "inject",
  z: "f1",
  props: [...(payload !== undefined ? [{ p: "payload" }] : []), { p: "topic", vt: "str" }],
  ...(payload !== undefined ? { payload, payloadType } : {}),
  topic,
  wires: [[wires]],
});
const req = (id, overrides = {}) => ({
  id,
  type: "centrifuge-request",
  z: "f1",
  server: "srv1",
  action: "rpc",
  target: "topic",
  targetType: "msg",
  wires: [["dbg1"]],
  ...overrides,
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
const catchNode = (id, scope, wires) => ({ id, type: "catch", z: "f1", scope, uncaught: false, wires: [[wires]] });
const debugErr = (id) => ({
  id,
  type: "debug",
  z: "f1",
  active: true,
  tosidebar: true,
  complete: "error",
  targetType: "msg",
  wires: [],
});
const tab = () => ({ id: "f1", type: "tab", label: "test" });

test("request1: rpc echo succeeds, payload is replaced, msg.centrifuge is set, backend receives the shaped POST", async () => {
  const flow = [
    server1(),
    inject("inj1", { topic: "echo", payload: JSON.stringify({ a: 1 }), wires: "req1" }),
    req("req1", { action: "rpc" }),
    debugFull("dbg1"),
    tab(),
  ];
  const connected = nr.waitForStatus("req1", (s) => s.text === "connected");
  await nr.deploy(flow);
  await connected;

  const before = backend.requests.length;
  const dbg = nr.waitForDebug((d) => d.id === "dbg1");
  await nr.inject("inj1");
  const msg = (await dbg).msg;
  assert.deepEqual(msg.payload, { method: "echo", data: { a: 1 }, user: "node-red" });
  assert.deepEqual(msg.centrifuge, { action: "rpc", method: "echo" });
  assert.equal(backend.requests.length, before + 1);
  const body = backend.requests.at(-1).body;
  assert.equal(body.method, "echo");
  assert.deepEqual(body.data, { a: 1 });
  assert.equal(body.user, "node-red");
  assert.ok(
    ["client", "transport", "protocol", "encoding"].every((k) => k in body),
    "backend POST shape",
  );
});

test("request1: rpc backend errors map to SERVER_ERROR with the numeric code in the message", async () => {
  const flow = [
    server1(),
    inject("injFail", { topic: "fail", payload: "null", wires: "req1" }),
    inject("injNope", { topic: "nope", payload: "1", wires: "req1" }),
    req("req1", { action: "rpc" }),
    debugFull("dbg1"),
    catchNode("catch1", ["req1"], "dbgerr1"),
    debugErr("dbgerr1"),
    tab(),
  ];
  const connected = nr.waitForStatus("req1", (s) => s.text === "connected");
  await nr.deploy(flow);
  await connected;

  {
    const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
    await nr.inject("injFail");
    const err = (await caught).msg;
    assert.equal(err.code, "SERVER_ERROR");
    assert.match(err.message, /server code 1001/);
  }
  {
    const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
    await nr.inject("injNope");
    const err = (await caught).msg;
    assert.equal(err.code, "SERVER_ERROR");
    assert.match(err.message, /server code 1002/);
  }
});

test("request1: rpc without an RPC proxy configured fails with server code 108 (not available)", async (t) => {
  const srvNoRpc = await startCentrifugo();
  t.after(() => srvNoRpc.stop());
  const flow = [
    server1({ id: "srv2", url: srvNoRpc.url, credentials: { secret: srvNoRpc.secret } }),
    inject("inj1", { topic: "echo", payload: "null", wires: "req1" }),
    req("req1", { server: "srv2", action: "rpc" }),
    catchNode("catch1", ["req1"], "dbgerr1"),
    debugErr("dbgerr1"),
    tab(),
  ];
  const connected = nr.waitForStatus("req1", (s) => s.text === "connected");
  await nr.deploy(flow);
  await connected;
  const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
  await nr.inject("inj1");
  const err = (await caught).msg;
  assert.equal(err.code, "SERVER_ERROR");
  assert.match(err.message, /server code 108/);
});

test("request1: oversize rpc command is refused locally; nothing reaches the backend", async () => {
  const flow = [
    server1({ id: "srv2", maxMessageSize: 200 }),
    inject("injBig", { topic: "echo", payload: JSON.stringify({ s: "x".repeat(300) }), wires: "req1" }),
    req("req1", { server: "srv2", action: "rpc" }),
    catchNode("catch1", ["req1"], "dbgerr1"),
    debugErr("dbgerr1"),
    tab(),
  ];
  const connected = nr.waitForStatus("req1", (s) => s.text === "connected");
  await nr.deploy(flow);
  await connected;
  const before = backend.requests.length;
  const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
  await nr.inject("injBig");
  const err = (await caught).msg;
  assert.equal(err.code, "INVALID_MESSAGE");
  assert.equal(backend.requests.length, before, "nothing reached the backend");
});

test("request1: history returns publications, supports limit/since/reverse, validates options, and maps namespace errors", async () => {
  const p1 = await srv.api("publish", { channel: "histX", data: { n: 1 } });
  await srv.api("publish", { channel: "histX", data: { n: 2 } });
  await srv.api("publish", { channel: "histX", data: { n: 3 } });

  const flow = [
    server1(),
    inject("injDefault", { topic: "histX", wires: "req1" }),
    inject("injLimit2", { topic: "histX", payload: JSON.stringify({ limit: 2 }), wires: "req1" }),
    inject("injRev", { topic: "histX", payload: JSON.stringify({ limit: 2, reverse: true }), wires: "req1" }),
    inject("injSince", {
      topic: "histX",
      payload: JSON.stringify({ limit: 10, since: { offset: p1.result.offset, epoch: p1.result.epoch } }),
      wires: "req1",
    }),
    inject("injBadPayload", { topic: "histX", payload: JSON.stringify("oops"), wires: "req1" }),
    inject("injBadKey", { topic: "histX", payload: JSON.stringify({ foo: 1 }), wires: "req1" }),
    inject("injLocked", { topic: "locked:x", wires: "req1" }),
    inject("injUnknown", { topic: "nohistory:x", wires: "req1" }),
    inject("injNoPerm", { topic: "noperm:x", wires: "req1" }),
    req("req1", { action: "history" }),
    debugFull("dbg1"),
    catchNode("catch1", ["req1"], "dbgerr1"),
    debugErr("dbgerr1"),
    tab(),
  ];
  const connected = nr.waitForStatus("req1", (s) => s.text === "connected");
  await nr.deploy(flow);
  await connected;

  {
    const dbg = nr.waitForDebug((d) => d.id === "dbg1");
    await nr.inject("injDefault");
    const msg = (await dbg).msg;
    assert.deepEqual(
      msg.payload.publications.map((p) => p.data),
      [{ n: 1 }, { n: 2 }, { n: 3 }],
      "default limit 100 returns everything oldest-first",
    );
    assert.deepEqual(msg.centrifuge, { action: "history", channel: "histX" });
  }
  {
    const dbg = nr.waitForDebug((d) => d.id === "dbg1");
    await nr.inject("injLimit2");
    const msg = (await dbg).msg;
    assert.deepEqual(
      msg.payload.publications.map((p) => p.data),
      [{ n: 1 }, { n: 2 }],
    );
  }
  {
    const dbg = nr.waitForDebug((d) => d.id === "dbg1");
    await nr.inject("injRev");
    const msg = (await dbg).msg;
    assert.deepEqual(
      msg.payload.publications.map((p) => p.data),
      [{ n: 3 }, { n: 2 }],
    );
  }
  {
    const dbg = nr.waitForDebug((d) => d.id === "dbg1");
    await nr.inject("injSince");
    const msg = (await dbg).msg;
    assert.deepEqual(
      msg.payload.publications.map((p) => p.data),
      [{ n: 2 }, { n: 3 }],
    );
  }
  for (const id of ["injBadPayload", "injBadKey"]) {
    const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
    await nr.inject(id);
    const err = (await caught).msg;
    assert.equal(err.code, "INVALID_MESSAGE", id);
  }
  {
    const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
    await nr.inject("injLocked");
    const err = (await caught).msg;
    assert.equal(err.code, "SERVER_ERROR");
    assert.match(err.message, /server code 108/);
  }
  {
    const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
    await nr.inject("injUnknown");
    const err = (await caught).msg;
    assert.equal(err.code, "SERVER_ERROR");
    assert.match(err.message, /server code 102/);
  }
  {
    // Verified empirically: a namespace with history enabled but allow_history_for_client: false answers 103.
    const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
    await nr.inject("injNoPerm");
    const err = (await caught).msg;
    assert.equal(err.code, "PERMISSION_DENIED");
    assert.match(err.message, /103/);
  }
});

test("request1: presence lists a subscribed client; presence_stats returns counts; payload is ignored", async (t) => {
  const flow = [
    server1(),
    inject("injPresence", { topic: "pres1", payload: '"ignored"', wires: "reqPresence" }),
    inject("injStats", { topic: "pres1", wires: "reqStats" }),
    req("reqPresence", { action: "presence", wires: [["dbg1"]] }),
    req("reqStats", { action: "presence_stats", wires: [["dbg2"]] }),
    debugFull("dbg1"),
    debugFull("dbg2"),
    tab(),
  ];
  const connected = nr.waitForStatus("reqPresence", (s) => s.text === "connected");
  await nr.deploy(flow);
  await connected;

  await observe(t, "pres1");

  {
    const dbg = nr.waitForDebug((d) => d.id === "dbg1");
    await nr.inject("injPresence");
    const msg = (await dbg).msg;
    assert.deepEqual(msg.centrifuge, { action: "presence", channel: "pres1" });
    const clients = Object.values(msg.payload.clients);
    assert.ok(
      clients.some((c) => c.user === "observer"),
      "observer present in presence",
    );
  }
  {
    const dbg = nr.waitForDebug((d) => d.id === "dbg2");
    await nr.inject("injStats");
    const msg = (await dbg).msg;
    assert.deepEqual(msg.centrifuge, { action: "presence_stats", channel: "pres1" });
    assert.ok(msg.payload.numClients >= 1);
    assert.ok(msg.payload.numUsers >= 1);
  }
});

test("request1: missing server config shows a red status and fails via MISSING_SERVER", async () => {
  const flow = [
    inject("inj1", { topic: "topic", wires: "req1" }),
    req("req1", { server: "" }),
    catchNode("catch1", ["req1"], "dbgerr1"),
    debugErr("dbgerr1"),
    tab(),
  ];
  const missing = nr.waitForStatus("req1", (s) => s.text === "missing server");
  await nr.deploy(flow);
  await missing;
  const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
  await nr.inject("inj1");
  const err = (await caught).msg;
  assert.equal(err.code, "MISSING_SERVER");
});

for (const action of ["history", "presence", "presence_stats"]) {
  test(`request ${action}: oversize commands fail locally and the next request succeeds`, async () => {
    const flow = [
      server1({ maxMessageSize: 200 }),
      inject("injBig", { topic: "é".repeat(150), wires: "req1" }),
      inject("injSmall", { topic: "news", wires: "req1" }),
      req("req1", { action }),
      debugFull("dbg1"),
      catchNode("catch1", ["req1"], "dbgerr1"),
      debugErr("dbgerr1"),
      tab(),
    ];
    const connected = nr.waitForStatus("req1", (s) => s.text === "connected");
    await nr.deploy(flow);
    await connected;
    const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
    await nr.inject("injBig");
    assert.equal((await caught).msg.code, "INVALID_MESSAGE");
    const result = nr.waitForDebug((d) => d.id === "dbg1");
    await nr.inject("injSmall");
    assert.deepEqual((await result).msg.centrifuge, { action, channel: "news" });
  });
}

test("request RPC: pending calls time out and a partial redeploy preserves the sibling connection", async () => {
  const flow = [
    server1({ timeout: 500 }),
    inject("injHold", { topic: "hold", payload: '"pending"', wires: "req1" }),
    inject("injEcho", { topic: "echo", payload: "false", wires: "req1" }),
    req("req1"),
    debugFull("dbg1"),
    catchNode("catch1", ["req1"], "dbgerr1"),
    debugErr("dbgerr1"),
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
  const timedOut = nr.waitForDebug((d) => d.id === "dbgerr1");
  await nr.inject("injHold");
  assert.equal((await timedOut).msg.code, "TIMEOUT");
  backend.release();

  const held = once(backend.events, "held", { signal: AbortSignal.timeout(5000) });
  await nr.inject("injHold");
  await held;
  const modified = (await nr.api("GET", "/flows")).map((n) => (n.id === "req1" ? { ...n, name: "renamed" } : n));
  await nr.deploy(modified, "nodes");
  backend.release();

  const result = nr.waitForDebug((d) => d.id === "dbg1");
  await nr.inject("injEcho");
  assert.equal((await result).msg.payload.data, false);
  const publication = nr.waitForDebug((d) => d.id === "dbgin");
  await srv.api("publish", { channel: "news", data: "after redeploy" });
  assert.equal((await publication).msg.payload, "after redeploy");
  const after = await srv.api("presence", { channel: "news" });
  assert.deepEqual(Object.keys(after.result.presence), Object.keys(before.result.presence));
});
