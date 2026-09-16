"use strict";
// Every shipped example deploys and produces its documented output against a real Centrifugo.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startNodeRed } = require("../helpers/node-red");
const { startCentrifugo } = require("../helpers/centrifugo");

const packageDir = path.resolve(__dirname, "../..");
const load = (name, srv) =>
  JSON.parse(fs.readFileSync(path.join(packageDir, "examples", name), "utf8")).map((n) =>
    n.type === "centrifuge-server" ? { ...n, url: srv.url, credentials: { secret: srv.secret } } : n,
  );
const byType = (flow, type) => flow.filter((n) => n.type === type);

test("examples/01-subscribe-and-publish.json: inject publishes and the in node receives it", async (t) => {
  const srv = await startCentrifugo();
  const nr = await startNodeRed({ packageDir });
  t.after(async () => {
    await nr.stop();
    await srv.stop();
  });
  const flow = load("01-subscribe-and-publish.json", srv);
  const inNode = byType(flow, "centrifuge-in")[0];
  const inject = byType(flow, "inject")[0];
  const debugs = byType(flow, "debug");
  const received = debugs.find((d) => d.name === "received");
  const acked = debugs.find((d) => d.name === "acknowledged");
  const subscribed = nr.waitForStatus(inNode.id, (s) => s.text === "subscribed");
  await nr.deploy(flow);
  await subscribed;
  const got = nr.waitForDebug((d) => d.id === received.id);
  const ack = nr.waitForDebug((d) => d.id === acked.id);
  await nr.inject(inject.id);
  assert.deepEqual((await got).msg.payload, { hello: "world" });
  assert.equal((await got).msg.centrifuge.event, "publication");
  assert.deepEqual((await ack).msg, { action: "publish", channel: "news" });
});

test("examples/02-server-side-subscriptions.json: server-side channel delivers a server API publish", async (t) => {
  const srv = await startCentrifugo();
  const nr = await startNodeRed({ packageDir });
  t.after(async () => {
    await nr.stop();
    await srv.stop();
  });
  const flow = load("02-server-side-subscriptions.json", srv);
  const inNode = byType(flow, "centrifuge-in")[0];
  assert.equal(inNode.mode, "server");
  const debug = byType(flow, "debug")[0];
  const subscribed = nr.waitForStatus(inNode.id, (s) => s.text === "subscribed");
  await nr.deploy(flow);
  await subscribed;
  const got = nr.waitForDebug((d) => d.id === debug.id);
  await srv.api("publish", { channel: inNode.channel, data: { hello: 1 } });
  assert.deepEqual((await got).msg.payload, { hello: 1 });
  assert.equal((await got).msg.topic, inNode.channel);
});

test("examples/03-request-rpc-history-presence.json: every request produces its documented result", async (t) => {
  const { startRpcBackend } = require("../helpers/rpc-backend");
  const backend = await startRpcBackend();
  let srv = null,
    nr = null;
  t.after(async () => {
    try {
      await nr?.stop();
    } finally {
      try {
        await srv?.stop();
      } finally {
        await backend.stop();
      }
    }
  });
  srv = await startCentrifugo({ config: backend.config });
  nr = await startNodeRed({ packageDir });
  const flow = load("03-request-rpc-history-presence.json", srv);
  const requests = byType(flow, "centrifuge-request");
  const connected = nr.waitForStatus(requests[0].id, (s) => s.text === "connected");
  await nr.deploy(flow);
  await connected;
  await srv.api("publish", { channel: "news", data: { example: 3 } });
  for (const request of requests) {
    const inject = byType(flow, "inject").find((n) => n.wires.flat().includes(request.id));
    const result = nr.waitForDebug((d) => d.id === request.wires[0][0]);
    await nr.inject(inject.id);
    const payload = (await result).msg;
    if (request.action === "history")
      assert.deepEqual(
        payload.publications.map((p) => p.data),
        [{ example: 3 }],
      );
    else if (request.action === "presence_stats") assert.deepEqual(payload, { numUsers: 0, numClients: 0 });
    else assert.deepEqual(payload, { method: "echo", data: { hello: "world" }, user: "node-red" });
  }
});

test("examples/04-map-subscription.json: sync snapshot, then a set and a remove reach the map subscriber", async (t) => {
  const srv = await startCentrifugo();
  const nr = await startNodeRed({ packageDir });
  t.after(async () => {
    await nr.stop();
    await srv.stop();
  });
  const flow = load("04-map-subscription.json", srv);
  const inNode = byType(flow, "centrifuge-in")[0];
  assert.equal(inNode.mode, "map");
  const debugs = byType(flow, "debug");
  const received = debugs.find((d) => d.name === "received");
  const setAck = debugs.find((d) => d.name === "set acknowledged");
  const removeAck = debugs.find((d) => d.name === "remove acknowledged");
  const injects = byType(flow, "inject");
  const setInject = injects.find((n) => n.name === "set sensor-1");
  const removeInject = injects.find((n) => n.name === "remove sensor-1");

  const subscribed = nr.waitForStatus(inNode.id, (s) => s.text === "subscribed");
  const sync = nr.waitForDebug((d) => d.id === received.id && d.msg.centrifuge.event === "sync");
  await nr.deploy(flow);
  await subscribed;
  const synced = (await sync).msg;
  assert.deepEqual(synced.payload, []);
  assert.deepEqual(synced.centrifuge, { event: "sync", channel: "kv:board" });

  const update1 = nr.waitForDebug((d) => d.id === received.id && d.msg.centrifuge.event === "update");
  const ack1 = nr.waitForDebug((d) => d.id === setAck.id);
  await nr.inject(setInject.id);
  const set = (await update1).msg;
  assert.equal(set.centrifuge.key, "sensor-1");
  assert.equal(set.payload.temperature, 21.5);
  assert.deepEqual((await ack1).msg, { action: "map_publish", channel: "kv:board", key: "sensor-1" });

  const update2 = nr.waitForDebug((d) => d.id === received.id && d.msg.centrifuge.removed === true);
  const ack2 = nr.waitForDebug((d) => d.id === removeAck.id);
  await nr.inject(removeInject.id);
  const removed = (await update2).msg;
  assert.equal(removed.centrifuge.key, "sensor-1");
  assert.equal(removed.payload, null);
  assert.deepEqual((await ack2).msg, { action: "map_remove", channel: "kv:board", key: "sensor-1" });
});
