"use strict";
// centrifuge-request dialog: action options, target TypedInput persistence, label toggle, and target validator.
const { test, expect } = require("./fixtures");
const E = require("./editor");

const flow = [
  { id: "f1", type: "tab", label: "e2e" },
  {
    id: "srv1",
    type: "centrifuge-server",
    name: "",
    url: "ws://127.0.0.1:1/connection/websocket",
    auth: "hmac",
    user: "node-red",
    channels: "",
    ttl: 3600,
    timeout: 2000,
    maxMessageSize: 65536,
    credentials: { secret: "x" },
  },
  {
    id: "req1",
    type: "centrifuge-request",
    z: "f1",
    name: "",
    server: "srv1",
    action: "rpc",
    target: "topic",
    targetType: "msg",
    wires: [[]],
  },
];

test("request dialog: action options, target persistence, label rule", async ({ page, nr }) => {
  await nr.deploy(flow);
  await page.setViewportSize({ width: 1440, height: 900 });
  await E.gotoEditor(page, nr, "light");
  await E.openNode(page, "req1");

  await expect(page.locator("#node-input-action option")).toHaveText([
    "RPC call",
    "History",
    "Presence",
    "Presence stats",
  ]);
  await expect(page.locator("#node-input-action")).toHaveValue("rpc");
  await expect(page.locator("#centrifuge-request-target-label")).toHaveText("Method");
  await expect(page.locator("#centrifuge-request-target-icon")).toHaveClass(/fa-code/);
  const initial = await page.evaluate(() => ({
    type: window.$("#node-input-target").typedInput("type"),
    value: window.$("#node-input-target").typedInput("value"),
  }));
  expect(initial).toEqual({ type: "msg", value: "topic" });

  // switching action toggles the target row's label/icon between Method (rpc) and Channel (other actions)
  await page.selectOption("#node-input-action", "history");
  await expect(page.locator("#centrifuge-request-target-label")).toHaveText("Channel");
  await expect(page.locator("#centrifuge-request-target-icon")).toHaveClass(/fa-hashtag/);
  await page.selectOption("#node-input-action", "rpc");
  await expect(page.locator("#centrifuge-request-target-label")).toHaveText("Method");
  await expect(page.locator("#centrifuge-request-target-icon")).toHaveClass(/fa-code/);

  // set action to presence_stats and target to a str value, save, and verify persistence + node label
  await page.selectOption("#node-input-action", "presence_stats");
  await page.evaluate(() => {
    window.$("#node-input-target").typedInput("type", "str");
    window.$("#node-input-target").typedInput("value", "news");
  });
  await expect(page.locator(".red-ui-tray-content .input-error")).toHaveCount(0);
  await E.closeDialog(page);

  const saved = await page.evaluate(() => {
    const n = RED.nodes.node("req1");
    return { action: n.action, target: n.target, targetType: n.targetType };
  });
  expect(saved).toEqual({ action: "presence_stats", target: "news", targetType: "str" });

  const label = await page.evaluate(() => RED.nodes.node("req1")._def.label.call(RED.nodes.node("req1")));
  expect(label).toBe("presence stats news");

  await E.openNode(page, "req1");
  const reopened = await page.evaluate(() => ({
    action: window.$("#node-input-action").val(),
    type: window.$("#node-input-target").typedInput("type"),
    value: window.$("#node-input-target").typedInput("value"),
  }));
  expect(reopened).toEqual({ action: "presence_stats", type: "str", value: "news" });

  // an empty target fails the required/typedInput validator
  await page.evaluate(() => window.$("#node-input-target").typedInput("value", ""));
  await expect(page.locator("#node-input-target")).toHaveClass(/input-error/);
  await E.closeDialog(page, { save: false });
});

test("request dialog: malformed imported actions render and remain invalid", async ({ page, nr }) => {
  await nr.deploy(flow.map((node) => (node.id === "req1" ? { ...node, action: 42 } : node)));
  await E.gotoEditor(page, nr, "light");
  await E.openNode(page, "req1");
  const invalid = await page.evaluate(() => {
    const node = RED.nodes.node("req1");
    return node._def.defaults.action.validate.call(node, node.action);
  });
  expect(invalid).toBe(false);
  await page.selectOption("#node-input-action", "history");
  await E.closeDialog(page);
  expect(await page.evaluate(() => RED.nodes.node("req1").action)).toBe("history");
});
