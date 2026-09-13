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
