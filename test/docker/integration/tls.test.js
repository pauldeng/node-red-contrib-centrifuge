"use strict";
// Tier 3: TLS. Proves the NODE_EXTRA_CA_CERTS path on the Node-RED child against a wss:// Centrifugo container with
// a self-signed certificate, and the documented failure mode when the CA is missing: the node stays "connecting",
// never "subscribed", and nothing throws uncaught.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { startNodeRed } = require("../../helpers/node-red");
const { startCentrifugoContainer } = require("../../helpers/docker");

const packageDir = path.resolve(__dirname, "../../..");

// Shared by the trusted and untrusted client: in1 subscribes to "news", out1 publishes to it on inject.
const flow = (srv) => [
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
  { id: "out1", type: "centrifuge-out", z: "f1", server: "srv1", channel: "news", channelType: "str", wires: [] },
  {
    id: "injOut",
    type: "inject",
    z: "f1",
    props: [{ p: "payload" }],
    payload: "viaOut",
    payloadType: "str",
    wires: [["out1"]],
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

test("wss with the private CA subscribes and round-trips; without the CA it stays connecting", async (t) => {
  const cleanups = [];
  t.after(async () => {
    const failures = [];
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Docker test cleanup failed");
  });

  const srv = await startCentrifugoContainer({ tls: true });
  cleanups.push(() => srv.stop());

  // (a) trusted client: sees the CA, subscribes, and round-trips both an API publish and an inject-triggered publish.
  const nr = await startNodeRed({ packageDir, env: { NODE_EXTRA_CA_CERTS: srv.caFile } });
  cleanups.push(() => nr.stop());

  const subscribed = nr.waitForStatus("in1", (s) => s.text === "subscribed");
  await nr.deploy(flow(srv));
  await subscribed;

  const viaApi = nr.waitForDebug((d) => d.id === "dbg1" && d.msg?.payload === "viaApi");
  await srv.api("publish", { channel: "news", data: "viaApi" });
  assert.equal((await viaApi).msg.payload, "viaApi");

  const viaOut = nr.waitForDebug((d) => d.id === "dbg1" && d.msg?.payload === "viaOut");
  await nr.inject("injOut");
  assert.equal((await viaOut).msg.payload, "viaOut");

  // (b) untrusted client: same container, no NODE_EXTRA_CA_CERTS. Stays connecting, never subscribes, never throws.
  const nr2 = await startNodeRed({ packageDir });
  cleanups.push(() => nr2.stop());

  const connecting = nr2.waitForStatus("in1", (s) => s.text === "connecting");
  await nr2.deploy(flow(srv));
  assert.equal((await connecting).text, "connecting");

  await assert.rejects(
    nr2.waitForStatus("in1", (s) => s.text === "subscribed", 4000), // allow-timer: bounded negative assertion - a self-signed cert with no trusted CA must never subscribe
    /timed out/,
  );

  assert.ok(
    !nr2.lines.some((l) => /Uncaught|TypeError|Unhandled/.test(l)),
    `unexpected uncaught error in Node-RED log:\n${nr2.lines.slice(-20).join("\n")}`,
  );
});
