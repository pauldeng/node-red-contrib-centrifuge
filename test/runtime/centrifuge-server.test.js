"use strict";
// Config-node lifecycle in a real Node-RED: close budget with the server dead, config redeploy, clean shutdown.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { startNodeRed } = require("../helpers/node-red");
const { startCentrifugo } = require("../helpers/centrifugo");

const packageDir = path.resolve(__dirname, "../..");
const flow = (srv, over = {}) => [
  {
    id: "srv1",
    type: "centrifuge-server",
    name: "t",
    url: srv.url,
    auth: "hmac",
    user: "node-red",
    channels: "",
    ttl: 3600,
    timeout: 1000,
    maxMessageSize: 65536,
    credentials: { secret: srv.secret },
    ...over,
  },
  {
    id: "in1",
    type: "centrifuge-in",
    z: "f1",
    server: "srv1",
    mode: "subscribe",
    channel: "news",
    joinLeave: false,
    subscriptionAuth: "none",
    wires: [["dbg1"]],
  },
  {
    id: "dbg1",
    type: "debug",
    z: "f1",
    active: true,
    tosidebar: true,
    complete: "true",
    targetType: "full",
    wires: [],
  },
  { id: "f1", type: "tab", label: "t" },
];

test("server killed: consumers show connecting, a full redeploy closes within the budget, and Node-RED exits cleanly", async (t) => {
  const srv = await startCentrifugo();
  const nr = await startNodeRed({ packageDir });
  t.after(async () => {
    await nr.stop();
    await srv.stop();
  });
  const subscribed = nr.waitForStatus("in1", (s) => s.text === "subscribed");
  await nr.deploy(flow(srv));
  await subscribed;

  const connecting = nr.waitForStatus("in1", (s) => s.text === "connecting");
  srv.child.kill("SIGKILL");
  await connecting;

  // Close with the server dead: the config node must not await the network.
  const started = performance.now();
  const stopped = nr.waitForLog(/Stopped flows/, { after: nr.lines.length });
  await nr.deploy([{ id: "f1", type: "tab", label: "empty" }]);
  await stopped;
  assert.ok(performance.now() - started < 5000, `close took ${Math.round(performance.now() - started)} ms`);

  // Node-RED itself must exit on SIGTERM without escalation (no leaked timers or sockets keep it alive).
  const exitStart = performance.now();
  await nr.stop();
  assert.ok(performance.now() - exitStart < 8000, "Node-RED exited before the SIGKILL escalation");
});

test("changing the config node reconnects; an invalid url shows invalid config on the consumer and never connects", async (t) => {
  const srv = await startCentrifugo();
  const nr = await startNodeRed({ packageDir });
  t.after(async () => {
    await nr.stop();
    await srv.stop();
  });
  const subscribed = nr.waitForStatus("in1", (s) => s.text === "subscribed");
  await nr.deploy(flow(srv));
  await subscribed;

  const invalid = nr.waitForStatus("in1", (s) => /^invalid config: url/.test(s.text));
  await nr.deploy(flow(srv, { url: "http://not-a-websocket/" }));
  assert.match((await invalid).text, /^invalid config: url must be an absolute ws:\/\/ or wss:\/\/ URL/);

  const back = nr.waitForStatus("in1", (s) => s.text === "subscribed");
  await nr.deploy(flow(srv));
  await back;
});
