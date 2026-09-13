"use strict";
// Tier 4 (docs/TESTING.md): red terminal status badges on the canvas, both themes. Reuses one container (no
// fault injection needed here, just a config that Centrifugo will always reject).
const { test, expect } = require("./fixtures");
const { gotoEditor, THEMES } = require("../../e2e/editor");

const tab = { id: "f1", type: "tab", label: "ui" };
const flow = (srv, overrides = {}) => [
  tab,
  {
    id: "srv1",
    type: "centrifuge-server",
    url: srv.url,
    auth: "hmac",
    user: "node-red",
    channels: "",
    ttl: 3600,
    timeout: 1500,
    maxMessageSize: 65536,
    credentials: { secret: "wrong" },
    ...overrides,
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
    x: 200,
    y: 100,
  },
];

const label = (page, id) => page.locator(`#${id} .red-ui-flow-node-status-label`);
const dot = (page, id) => page.locator(`#${id} .red-ui-flow-node-status`);
const canvas = (page) => page.locator("#red-ui-workspace-chart");

for (const theme of THEMES) {
  test(`terminal status is red: invalid token (${theme})`, async ({ page, nr, srv }) => {
    const disconnected = nr.waitForStatus("in1", (s) => s.text === "disconnected: invalid token (3500)");
    await nr.deploy(flow(srv));
    await disconnected;

    await gotoEditor(page, nr, theme);
    await expect(label(page, "in1")).toHaveText("disconnected: invalid token (3500)");
    await expect(dot(page, "in1")).toHaveClass(/red-ui-flow-node-status-ring-red/);
    await canvas(page).screenshot({ path: `test-results/screenshots/status-terminal-${theme}.png` });
  });
}

// Optional (docs/TESTING.md tier 4 "if time allows"): anonymous auth against a server that requires a token.
// Records whatever terminal label Centrifugo's rejection produces rather than assuming a code.
test("anonymous auth against a server that forbids it: whatever terminal label appears", async ({ page, nr, srv }) => {
  const terminal = nr.waitForStatus("in1", (s) => s.fill === "red");
  await nr.deploy(flow(srv, { auth: "none", credentials: undefined }));
  const status = await terminal;
  console.log(`anonymous-auth terminal status: ${status.text}`);

  await gotoEditor(page, nr, "light");
  await expect(label(page, "in1")).toHaveText(status.text);
  await expect(dot(page, "in1")).toHaveClass(/red-ui-flow-node-status-ring-red/);
});
