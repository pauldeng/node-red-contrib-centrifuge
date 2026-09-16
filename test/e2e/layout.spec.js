"use strict";
// Layout across the four dialogs: no horizontal overflow at 1440x900 and 800x600, light and dark.
// Look at the screenshots in test-results/screenshots/ before declaring the UI done.
const { test, expect } = require("./fixtures");
const E = require("./editor");

const flow = [
  { id: "f1", type: "tab", label: "e2e" },
  {
    id: "srv1",
    type: "centrifuge-server",
    name: "local",
    url: "ws://127.0.0.1:1/connection/websocket",
    auth: "hmac",
    user: "node-red",
    channels: "news\nalerts",
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
  {
    id: "out1",
    type: "centrifuge-out",
    z: "f1",
    name: "",
    server: "srv1",
    channel: "topic",
    channelType: "msg",
    wires: [[]],
  },
  {
    id: "req1",
    type: "centrifuge-request",
    z: "f1",
    name: "",
    server: "srv1",
    action: "history",
    target: "topic",
    targetType: "msg",
    wires: [[]],
  },
];

const dialogs = [
  { name: "server", open: (page) => E.openConfig(page, "centrifuge-server", "srv1"), config: true },
  { name: "in", open: (page) => E.openNode(page, "in1"), config: false },
  { name: "out", open: (page) => E.openNode(page, "out1"), config: false },
  { name: "request", open: (page) => E.openNode(page, "req1"), config: false },
];

for (const dialog of dialogs)
  for (const theme of E.THEMES)
    for (const vp of E.VIEWPORTS) {
      test(`${dialog.name} dialog layout ${theme}/${vp.width}x${vp.height}`, async ({ page, nr }) => {
        await nr.deploy(flow);
        await page.setViewportSize(vp);
        await E.gotoEditor(page, nr, theme);
        await dialog.open(page);
        await expect(page.locator(".red-ui-tray-content .input-error")).toHaveCount(0);
        // screenshot before the overflow assertion so a failure still leaves the image to look at
        await page.screenshot({
          path: `test-results/screenshots/${dialog.name}-${theme}-${vp.width}x${vp.height}.png`,
        });
        await E.assertNoOverflow(page);
        await E.closeDialog(page, { save: false, config: dialog.config });
      });
    }
