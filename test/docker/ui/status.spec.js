"use strict";
// Tier 4 (docs/TESTING.md): live status badges on the editor canvas against a real Centrifugo container, both
// themes, through a real `docker pause`/`unpause` stall. Screenshots land in test-results/screenshots/ for a human
// to inspect (legibility, dot/ring colour, no overlap) - this suite only proves the DOM state, not the pixels.
const { test, expect } = require("./fixtures");
const { gotoEditor, THEMES } = require("../../e2e/editor");

const tab = { id: "f1", type: "tab", label: "ui" };
const server = (srv) => ({
  id: "srv1",
  type: "centrifuge-server",
  url: srv.url,
  auth: "hmac",
  user: "node-red",
  channels: "",
  ttl: 3600,
  timeout: 1500,
  maxMessageSize: 65536,
  credentials: { secret: srv.secret },
});
const inNode = (id, mode, channel, x, y) => ({
  id,
  type: "centrifuge-in",
  z: "f1",
  name: "",
  server: "srv1",
  mode,
  channel,
  joinLeave: false,
  subscriptionAuth: "none",
  wires: [[]],
  x,
  y,
});
const outNode = {
  id: "out1",
  type: "centrifuge-out",
  z: "f1",
  name: "",
  server: "srv1",
  channel: "topic",
  channelType: "msg",
  wires: [[]],
  x: 480,
  y: 100,
};
const flow = (srv) => [
  tab,
  server(srv),
  inNode("in1", "subscribe", "news", 200, 100),
  inNode("in2", "subscribe", "locked:x", 200, 180),
  inNode("in3", "server", "nope", 200, 260),
  outNode,
];

const label = (page, id) => page.locator(`#${id} .red-ui-flow-node-status-label`);
const canvas = (page) => page.locator("#red-ui-workspace-chart");

for (const theme of THEMES) {
  test(`status badges: live, then through a stall (${theme})`, async ({ page, nr, srv }) => {
    const subscribed = nr.waitForStatus("in1", (s) => s.text === "subscribed");
    const denied = nr.waitForStatus("in2", (s) => s.text === "unsubscribed: permission denied (103)");
    await nr.deploy(flow(srv));
    await Promise.all([subscribed, denied]);

    await gotoEditor(page, nr, theme);
    await expect(label(page, "in1")).toHaveText("subscribed");
    await expect(label(page, "in2")).toHaveText("unsubscribed: permission denied (103)");
    await expect(label(page, "in3")).toHaveText("awaiting server subscription");
    await expect(label(page, "out1")).toHaveText("connected");
    await canvas(page).screenshot({ path: `test-results/screenshots/status-live-${theme}.png` });

    await srv.pause();
    await expect(label(page, "in1")).toHaveText("connecting", { timeout: 25_000 });
    await expect(label(page, "out1")).toHaveText("connecting", { timeout: 25_000 });
    await canvas(page).screenshot({ path: `test-results/screenshots/status-stalled-${theme}.png` });

    await srv.unpause();
    await expect(label(page, "in1")).toHaveText("subscribed", { timeout: 25_000 });
  });
}
