"use strict";
// Config-node lifecycle in a real Node-RED: close budget with the server dead, config redeploy, clean shutdown.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { runBounded } = require("../../lib/lifecycle");
const { startNodeRed } = require("../helpers/node-red");
const { startCentrifugo } = require("../helpers/centrifugo");

const packageDir = path.resolve(__dirname, "../..");

test("config-node status callbacks are isolated at registration and on connection transitions", async (t) => {
  const srv = await startCentrifugo();
  const events = new EventEmitter();
  // eslint-disable-next-line prefer-const -- assigned after the cleanup hook that reads it is registered
  let server;
  t.after(async () => {
    try {
      if (server) {
        const closed = Promise.withResolvers();
        events.emit("close", false, closed.resolve);
        await closed.promise;
      }
    } finally {
      await srv.stop();
    }
  });
  const warnings = [];
  let Constructor;
  require("../../nodes/centrifuge-server")({
    nodes: {
      registerType: (_type, ctor) => {
        Constructor = ctor;
      },
      createNode(node) {
        node.on = events.on.bind(events);
        node.credentials = { secret: srv.secret };
        node.debug = () => {};
        node.warn = (message) => warnings.push(message);
      },
    },
  });
  server = new Constructor({ url: srv.url });
  assert.doesNotThrow(() =>
    server.register({ id: "broken" }, () => {
      throw new Error("synthetic-secret");
    }),
  );
  const connected = Promise.withResolvers();
  const statuses = [];
  server.register({ id: "sibling" }, (status) => {
    statuses.push(status.text);
    if (status.text === "connected") connected.resolve();
  });
  await runBounded(() => connected.promise, { timeout: 5000 });
  assert.deepEqual(statuses, ["connecting", "connected"]);
  assert.ok(warnings.length >= 2, "both registration and connected callback failures were handled");
  for (const warning of warnings) assert.equal(warning, "centrifuge consumer callback failed");
});

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
