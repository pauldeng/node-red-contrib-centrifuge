"use strict";
// centrifuge-in dialog: mode-dependent rows, persistence across save/reopen, channel validator in subscribe mode.
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
    id: "in1",
    type: "centrifuge-in",
    z: "f1",
    name: "",
    server: "srv1",
    mode: "subscribe",
    channel: "news",
    joinLeave: false,
    subscriptionAuth: "none",
    wires: [[]],
  },
];

test("in dialog: mode rows, persistence, channel validator", async ({ page, nr }) => {
  await nr.deploy(flow);
  await page.setViewportSize({ width: 1440, height: 900 });
  await E.gotoEditor(page, nr, "light");
  await E.openNode(page, "in1");

  // five mode options: subscribe, server-side, and the three map modes
  await expect(page.locator("#node-input-mode option")).toHaveCount(5);

  // subscribe mode: channel/joinLeave/subscriptionAuth rows all shown
  await expect(page.locator("#node-input-channel")).toBeVisible();
  await expect(page.locator("#node-input-joinLeave")).toBeVisible();
  await expect(page.locator("#centrifuge-in-row-auth")).toBeVisible();
  await expect(page.locator("#node-input-subscriptionAuth")).toBeVisible();
  await expect(page.locator("#centrifuge-in-channel-hint")).toBeHidden();
  await expect(page.locator("#centrifuge-in-channel-label")).toHaveText("Channel");

  // server mode: subscriptionAuth row hides, channel stays visible/editable as a filter, join/leave stays shown
  await page.selectOption("#node-input-mode", "server");
  await expect(page.locator("#centrifuge-in-row-auth")).toBeHidden();
  await expect(page.locator("#centrifuge-in-row-joinleave")).toBeVisible();
  await expect(page.locator("#centrifuge-in-channel-hint")).toBeVisible();
  await expect(page.locator("#centrifuge-in-channel-label")).toHaveText("Filter");
  await expect(page.locator("#node-input-channel")).toBeVisible();
  await expect(page.locator("#node-input-channel")).toBeEditable();

  // map mode: join/leave row hides (server-managed), auth row and channel (labelled "Channel") stay
  await page.selectOption("#node-input-mode", "map");
  await expect(page.locator("#centrifuge-in-row-joinleave")).toBeHidden();
  await expect(page.locator("#centrifuge-in-row-auth")).toBeVisible();
  await expect(page.locator("#centrifuge-in-channel-hint")).toBeHidden();
  await expect(page.locator("#centrifuge-in-channel-label")).toHaveText("Channel");

  // map mode requires a non-empty channel, same as subscribe mode
  await page.fill("#node-input-channel", "");
  await page.keyboard.press("Tab");
  await expect(page.locator("#node-input-channel")).toHaveClass(/input-error/);
  await page.fill("#node-input-channel", "kv:board");
  await page.keyboard.press("Tab");
  await expect(page.locator("#node-input-channel")).not.toHaveClass(/input-error/);

  // save in map mode: mode persists and the label follows the "map: <channel>" rule
  await expect(page.locator(".red-ui-tray-content .input-error")).toHaveCount(0);
  await E.closeDialog(page);
  const label = await page.evaluate(() => RED.nodes.node("in1")._def.label.call(RED.nodes.node("in1")));
  expect(label).toBe("map: kv:board");

  await E.openNode(page, "in1");
  await expect(page.locator("#node-input-mode")).toHaveValue("map");
  await expect(page.locator("#node-input-channel")).toHaveValue("kv:board");
  await expect(page.locator("#centrifuge-in-row-joinleave")).toBeHidden();

  // back to subscribe mode with the values under test
  await page.selectOption("#node-input-mode", "subscribe");
  await expect(page.locator("#centrifuge-in-row-joinleave")).toBeVisible();
  await page.fill("#node-input-channel", "news");
  await page.check("#node-input-joinLeave");
  await page.selectOption("#node-input-subscriptionAuth", "hmac");
  await expect(page.locator(".red-ui-tray-content .input-error")).toHaveCount(0);

  await E.closeDialog(page);
  await E.openNode(page, "in1");
  await expect(page.locator("#node-input-mode")).toHaveValue("subscribe");
  await expect(page.locator("#node-input-channel")).toHaveValue("news");
  await expect(page.locator("#node-input-joinLeave")).toBeChecked();
  await expect(page.locator("#node-input-subscriptionAuth")).toHaveValue("hmac");

  // subscribe mode requires a non-empty channel
  await page.fill("#node-input-channel", "");
  await expect(page.locator("#node-input-channel")).toHaveClass(/input-error/);
  await E.closeDialog(page, { save: false });
});
