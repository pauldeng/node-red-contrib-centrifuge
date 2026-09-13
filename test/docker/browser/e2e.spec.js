"use strict";
// Tier 5 (docs/TESTING.md): real browser (Chromium via Playwright) running centrifuge-js against a containerised
// Centrifugo, driven together with the official Node-RED image (package installed from its own tarball). One
// compose stack for the whole file (worker-scoped fixtures in ./fixtures.js). Fixed host ports 18800/18801 are
// acceptable for this tier and documented there; a busy port fails the run with a clear message.
// `window` above is a lint hint only: every reference lives inside a page.evaluate() callback that Playwright
// serializes and runs in the browser page, never in this (Node) process.
const { test, expect } = require("./fixtures");

const SERVER = {
  id: "srv1",
  type: "centrifuge-server",
  name: "local",
  url: "ws://centrifugo:8000/connection/websocket", // reached inside the compose network by service name
  auth: "hmac",
  user: "node-red",
  channels: "",
  ttl: 3600,
  timeout: 5000,
  maxMessageSize: 65536,
  credentials: { secret: "test-secret" },
};
// Node-RED only treats a node as a real flow node (wired, instantiated in flow order) when it carries x/y;
// without them it is bucketed as a config node and never runs. Every non-config node below needs a position.
const debugNode = (id, complete = "false") => ({
  id,
  type: "debug",
  z: "f1",
  name: id,
  active: true,
  tosidebar: true,
  console: false,
  tostatus: false,
  complete,
  targetType: "msg",
  statusVal: "",
  statusType: "auto",
  x: 500,
  y: 200,
  wires: [],
});

test.describe("flow to browser", () => {
  test("inject publishes through centrifuge out, the browser page receives it", async ({ stack, openClient }) => {
    await stack.deploy([
      { id: "f1", type: "tab", label: "flow-to-browser" },
      SERVER,
      {
        id: "inj1",
        type: "inject",
        z: "f1",
        name: "",
        props: [{ p: "payload" }, { p: "topic", vt: "str" }],
        payload: '{"hello":"browser"}',
        payloadType: "json",
        topic: "news",
        x: 200,
        y: 120,
        wires: [["out1"]],
      },
      {
        id: "out1",
        type: "centrifuge-out",
        z: "f1",
        name: "",
        server: "srv1",
        channel: "topic",
        channelType: "msg",
        x: 400,
        y: 120,
        wires: [[]],
      },
    ]);

    const page = await openClient("news");
    await expect.poll(() => page.evaluate(() => window.state())).toBe("connected");
    await expect.poll(() => page.evaluate(() => window.subscribed)).toBe(true);

    await stack.inject("inj1");

    await expect.poll(() => page.evaluate(() => window.received)).toContainEqual({ hello: "browser" });
  });
});

test.describe("browser to flow", () => {
  test("browser publish is received by centrifuge in and shown on the debug sidebar", async ({ stack, openClient }) => {
    await stack.deploy([
      { id: "f1", type: "tab", label: "browser-to-flow" },
      SERVER,
      {
        id: "in1",
        type: "centrifuge-in",
        z: "f1",
        name: "",
        server: "srv1",
        mode: "subscribe",
        channel: "news",
        joinLeave: false,
        subscriptionAuth: "none",
        x: 200,
        y: 120,
        wires: [["dbg1"]],
      },
      debugNode("dbg1"),
    ]);
    const comms = await stack.comms();
    try {
      await comms.waitForStatus("in1", (s) => s.text === "subscribed");
      const page = await openClient("news");
      await expect.poll(() => page.evaluate(() => window.subscribed)).toBe(true);

      const received = comms.waitForDebug((d) => d.msg?.from === "browser");
      const [data] = await Promise.all([received, page.evaluate(() => window.publish({ from: "browser" }))]);
      expect(data.msg).toEqual({ from: "browser" });
    } finally {
      comms.close();
    }
  });
});

test.describe("join/leave", () => {
  test("browser subscribe/close is seen as join then leave", async ({ stack, openClient }) => {
    await stack.deploy([
      { id: "f1", type: "tab", label: "join-leave" },
      SERVER,
      {
        id: "in1",
        type: "centrifuge-in",
        z: "f1",
        name: "",
        server: "srv1",
        mode: "subscribe",
        channel: "room",
        joinLeave: true,
        subscriptionAuth: "none",
        x: 200,
        y: 120,
        wires: [["dbg1"]],
      },
      debugNode("dbg1", "true"),
    ]);
    const comms = await stack.comms();
    try {
      await comms.waitForStatus("in1", (s) => s.text === "subscribed");
      const joinedEvent = comms.waitForDebug(
        (d) => d.msg?.centrifuge?.event === "join" && d.msg?.payload?.user === "browser",
      );
      const [joined, page] = await Promise.all([joinedEvent, openClient("room", { sub: "browser" })]);
      await expect.poll(() => page.evaluate(() => window.subscribed)).toBe(true);
      expect(joined.msg.centrifuge.event).toBe("join");

      const leftEvent = comms.waitForDebug(
        (d) => d.msg?.centrifuge?.event === "leave" && d.msg?.payload?.user === "browser",
      );
      const [left] = await Promise.all([leftEvent, page.close()]);
      expect(left.msg.centrifuge.event).toBe("leave");
    } finally {
      comms.close();
    }
  });
});
