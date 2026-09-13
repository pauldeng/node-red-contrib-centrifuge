"use strict";
// The Centrifugal mark renders on both nodes in the palette and on the canvas, light and dark.
// Look at test-results/screenshots/icon-*.png before declaring the icon done.
const { test, expect } = require("./fixtures");
const E = require("./editor");

const flow = [
  { id: "f1", type: "tab", label: "icons" },
  {
    id: "srv1",
    type: "centrifuge-server",
    name: "local",
    url: "ws://127.0.0.1:1/connection/websocket",
    auth: "none",
    user: "",
    channels: "",
    ttl: 3600,
    timeout: 5000,
    maxMessageSize: 65536,
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
    x: 460,
    y: 120,
    wires: [[]],
  },
];

for (const theme of E.THEMES) {
  test(`icon renders in palette and on canvas (${theme})`, async ({ page, nr }) => {
    await nr.deploy(flow);
    await page.setViewportSize({ width: 1100, height: 600 });
    await E.gotoEditor(page, nr, theme);
    // the palette filters on keyup, so type key by key instead of fill()
    await page.locator("#red-ui-palette-search input").pressSequentially("centrifuge");
    await expect(page.locator("#red-ui-palette .red-ui-palette-node:visible")).toHaveCount(2);
    const count = await page.evaluate(
      () =>
        [...document.querySelectorAll("image")].filter((i) =>
          (i.getAttribute("href") || i.getAttribute("xlink:href") || "").includes("centrifuge.svg"),
        ).length,
    );
    expect(count, "canvas icon images").toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: `test-results/screenshots/icon-${theme}.png` });
  });
}
