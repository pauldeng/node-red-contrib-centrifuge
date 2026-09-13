"use strict";
// Tier 3 (binary-independent, kept here since it needs a live server): a static "token" auth connection token with
// a short ttl. Proves the node goes subscribed -> disconnected: unauthorized (1) once the token actually expires,
// and that the terminal transition is logged exactly once (lib/status.js renders each distinct status once).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { startNodeRed } = require("../../helpers/node-red");
const { startCentrifugoContainer } = require("../../helpers/docker");
const { connectionToken } = require("../../../lib/jwt");

const packageDir = path.resolve(__dirname, "../../..");

test("a token connection expires: subscribed then disconnected: unauthorized (1), logged once", async (t) => {
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

  const srv = await startCentrifugoContainer();
  cleanups.push(() => srv.stop());

  const nr = await startNodeRed({ packageDir });
  cleanups.push(() => nr.stop());

  // Start the short token lifetime after the runtime is ready, so a slow cold start cannot consume it.
  const token = connectionToken({ secret: srv.secret, ttl: 4 });

  const flow = [
    {
      id: "srv1",
      type: "centrifuge-server",
      name: "t",
      url: srv.url,
      auth: "token",
      user: "node-red",
      channels: "",
      ttl: 3600,
      timeout: 1000,
      maxMessageSize: 65536,
      credentials: { token },
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

  const subscribed = nr.waitForStatus("in1", (s) => s.text === "subscribed");
  const disconnected = nr.waitForStatus("in1", (s) => s.text === "disconnected: unauthorized (1)", 10_000);
  await nr.deploy(flow);
  await Promise.all([subscribed, disconnected]);
  await nr.waitForLog(/disconnected: unauthorized \(1\)/);

  const hits = nr.lines.filter((l) => l.includes("disconnected: unauthorized (1)"));
  assert.equal(hits.length, 1, `expected exactly one log line, got:\n${hits.join("\n")}`);
});
