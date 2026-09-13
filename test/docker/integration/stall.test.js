"use strict";
// Tier 3: network fault. `docker pause` freezes the container (TCP stays open, nothing answers) - a real stall, not
// a mock. Proves the SDK's missing-server-ping detection moves the consumer to "connecting", an in-flight publish
// fails TIMEOUT (not hung forever), and `docker unpause` lets the connection recover and resubscribe.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { startNodeRed } = require("../../helpers/node-red");
const { startCentrifugoContainer } = require("../../helpers/docker");

const packageDir = path.resolve(__dirname, "../../..");

test("docker pause stalls the connection; timeout fires; docker unpause recovers", async (t) => {
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

  // Short server ping so a paused container is detected quickly (see docs/TESTING.md tier 3). Centrifugo requires
  // ping_interval > pong_timeout (validated at startup), so pong_timeout is well under the 1s ping_interval; only
  // ping_interval affects the SDK's client-side dead-connection detection used below.
  const srv = await startCentrifugoContainer({ config: { client: { ping_interval: "1s", pong_timeout: "500ms" } } });
  cleanups.push(() => srv.stop());

  const nr = await startNodeRed({ packageDir });
  cleanups.push(() => nr.stop());

  const flow = [
    {
      id: "srv1",
      type: "centrifuge-server",
      name: "t",
      url: srv.url,
      auth: "hmac",
      user: "node-red",
      channels: "",
      ttl: 3600,
      timeout: 1500,
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
      id: "inj1",
      type: "inject",
      z: "f1",
      props: [{ p: "payload" }],
      payload: "hello",
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
    { id: "catch1", type: "catch", z: "f1", scope: ["out1"], uncaught: false, wires: [["dbgerr1"]] },
    {
      id: "dbgerr1",
      type: "debug",
      z: "f1",
      active: true,
      tosidebar: true,
      complete: "error",
      targetType: "msg",
      wires: [],
    },
    {
      id: "injRecovery",
      type: "inject",
      z: "f1",
      props: [{ p: "payload" }],
      payload: "after-recovery",
      payloadType: "str",
      wires: [["out1"]],
    },
    { id: "f1", type: "tab", label: "t" },
  ];

  const subscribed = nr.waitForStatus("in1", (s) => s.text === "subscribed");
  await nr.deploy(flow);
  await subscribed;

  const connecting = nr.waitForStatus("in1", (s) => s.text === "connecting", 20_000);
  const pauseStart = performance.now();
  await srv.pause();
  let paused = true;
  cleanups.push(async () => {
    if (paused) await srv.unpause();
  });

  // Publish before the SDK's no-ping timeout: this exercises a dispatched command on an open but stalled TCP
  // connection, rather than only waiting for readiness after a disconnect has already been detected.
  const caught = nr.waitForDebug((d) => d.id === "dbgerr1");
  const publishStart = performance.now();
  await nr.inject("inj1");
  const err = (await caught).msg;
  const elapsed = performance.now() - publishStart;
  assert.equal(err.code, "TIMEOUT");
  assert.ok(elapsed >= 1200 && elapsed < 4000, `publish TIMEOUT took ${Math.round(elapsed)} ms`);

  await connecting;
  console.log(`[stall.test.js] stall detected after ${Math.round(performance.now() - pauseStart)} ms`);
  const resubscribed = nr.waitForStatus("in1", (s) => s.text === "subscribed");
  await srv.unpause();
  paused = false;
  await resubscribed;

  // The earlier timed-out command may still be delivered after unpause; distinguish the new publication.
  const publication = nr.waitForDebug((d) => d.id === "dbg1" && d.msg?.payload === "after-recovery");
  await nr.inject("injRecovery");
  const msg = (await publication).msg;
  assert.equal(msg.centrifuge.event, "publication");
  assert.equal(msg.payload, "after-recovery");
});
