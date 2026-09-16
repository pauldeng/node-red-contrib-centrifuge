"use strict";
// centrifuge-out dialog: the channel TypedInput default and persistence of its type/value across save/reopen,
// the mode options, the key row's conditional visibility/persistence, and the map-mode label rule.
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
    id: "out1",
    type: "centrifuge-out",
    z: "f1",
    name: "",
    server: "srv1",
    channel: "topic",
    channelType: "msg",
    mode: "publish",
    key: "key",
    keyType: "msg",
    wires: [[]],
  },
];

test("out dialog: channel TypedInput persistence", async ({ page, nr }) => {
  await nr.deploy(flow);
  await page.setViewportSize({ width: 1440, height: 900 });
  await E.gotoEditor(page, nr, "light");
  await E.openNode(page, "out1");

  await expect(page.locator(".red-ui-tray-content .input-error")).toHaveCount(0);
  const initial = await page.evaluate(() => ({
    type: window.$("#node-input-channel").typedInput("type"),
    value: window.$("#node-input-channel").typedInput("value"),
  }));
  expect(initial).toEqual({ type: "msg", value: "topic" });

  await page.evaluate(() => {
    window.$("#node-input-channel").typedInput("type", "str");
    window.$("#node-input-channel").typedInput("value", "news");
  });
  await E.closeDialog(page);

  const saved = await page.evaluate(() => {
    const n = RED.nodes.node("out1");
    return { channel: n.channel, channelType: n.channelType };
  });
  expect(saved).toEqual({ channel: "news", channelType: "str" });

  await E.openNode(page, "out1");
  const reopened = await page.evaluate(() => ({
    type: window.$("#node-input-channel").typedInput("type"),
    value: window.$("#node-input-channel").typedInput("value"),
  }));
  expect(reopened).toEqual({ type: "str", value: "news" });
  await E.closeDialog(page, { save: false });
});

test("out dialog: mode options, key row visibility, persistence and label rule", async ({ page, nr }) => {
  await nr.deploy(flow);
  await page.setViewportSize({ width: 1440, height: 900 });
  await E.gotoEditor(page, nr, "light");
  await E.openNode(page, "out1");

  await expect(page.locator("#node-input-mode option")).toHaveText([
    "Publish to a channel",
    "Map: set a key",
    "Map: remove a key",
  ]);
  await expect(page.locator("#node-input-mode")).toHaveValue("publish");
  await expect(page.locator("#centrifuge-out-row-key")).toBeHidden();

  await page.selectOption("#node-input-mode", "map_publish");
  await expect(page.locator("#centrifuge-out-row-key")).toBeVisible();
  const keyDefault = await page.evaluate(() => ({
    type: window.$("#node-input-key").typedInput("type"),
    value: window.$("#node-input-key").typedInput("value"),
  }));
  expect(keyDefault).toEqual({ type: "msg", value: "key" });

  await page.evaluate(() => {
    window.$("#node-input-channel").typedInput("type", "str");
    window.$("#node-input-channel").typedInput("value", "kv:board");
    window.$("#node-input-key").typedInput("type", "str");
    window.$("#node-input-key").typedInput("value", "score");
  });
  await expect(page.locator(".red-ui-tray-content .input-error")).toHaveCount(0);
  await E.closeDialog(page);

  const saved = await page.evaluate(() => {
    const n = RED.nodes.node("out1");
    return { mode: n.mode, key: n.key, keyType: n.keyType, channel: n.channel, channelType: n.channelType };
  });
  expect(saved).toEqual({ mode: "map_publish", key: "score", keyType: "str", channel: "kv:board", channelType: "str" });

  const label = await page.evaluate(() => RED.nodes.node("out1")._def.label.call(RED.nodes.node("out1")));
  expect(label).toBe("map set kv:board");

  await E.openNode(page, "out1");
  await expect(page.locator("#node-input-mode")).toHaveValue("map_publish");
  await expect(page.locator("#centrifuge-out-row-key")).toBeVisible();
  const reopened = await page.evaluate(() => ({
    type: window.$("#node-input-key").typedInput("type"),
    value: window.$("#node-input-key").typedInput("value"),
  }));
  expect(reopened).toEqual({ type: "str", value: "score" });

  // switching back to publish hides the key row again
  await page.selectOption("#node-input-mode", "publish");
  await expect(page.locator("#centrifuge-out-row-key")).toBeHidden();
  await E.closeDialog(page, { save: false });
});
