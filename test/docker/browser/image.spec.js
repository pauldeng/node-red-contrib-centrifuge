"use strict";
// Tier 5 (docs/TESTING.md): the packaging/registration checks that only the real official image can catch —
// palette, icon, help, and dialog rendering against a Node-RED started from `npm install <tarball>`, not a
// bind-mounted workspace. Shares the compose stack from ./fixtures.js (worker-scoped) with e2e.spec.js.
const { test, expect, NR_BASE } = require("./fixtures");
const E = require("../../e2e/editor"); // reused as-is: gotoEditor/openNode need only {base} + a page, no local child

const flow = [
  { id: "f1", type: "tab", label: "image-check" },
  {
    id: "srv1",
    type: "centrifuge-server",
    name: "local",
    url: "ws://centrifugo:8000/connection/websocket",
    auth: "hmac",
    user: "node-red",
    channels: "",
    ttl: 3600,
    timeout: 5000,
    maxMessageSize: 65536,
    credentials: { secret: "test-secret" },
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
    wires: [[]],
  },
];

test("real image: /nodes lists the three types enabled with no error", async ({ stack }) => {
  await stack.deploy(flow);
  const res = await fetch(`${NR_BASE}/nodes`, { headers: { accept: "application/json" } });
  expect(res.ok).toBe(true);
  const nodes = (await res.json()).filter((n) => n.module === "node-red-contrib-centrifuge");
  expect(nodes.map((n) => n.name).sort()).toEqual(["centrifuge-in", "centrifuge-out", "centrifuge-server"]);
  for (const n of nodes) {
    expect(n.enabled, `${n.name} enabled`).toBe(true);
    expect(n.err, `${n.name} err`).toBeUndefined();
  }
});

test("real image: /icons lists centrifuge.svg under the package", async ({ stack: _stack }) => {
  const res = await fetch(`${NR_BASE}/icons`, { headers: { accept: "application/json" } });
  expect(res.ok).toBe(true);
  const icons = await res.json();
  expect(icons["node-red-contrib-centrifuge"]).toContain("centrifuge.svg");
});

test("real image: palette search and dialog render in the official distribution", async ({ stack, page }) => {
  await stack.deploy(flow);
  await page.setViewportSize({ width: 1100, height: 700 });
  await E.gotoEditor(page, { base: NR_BASE }, "light");

  // the palette filters on keyup, so type key by key instead of fill()
  await page.locator("#red-ui-palette-search input").pressSequentially("centrifuge");
  await expect(page.locator("#red-ui-palette .red-ui-palette-node:visible")).toHaveCount(2);

  await E.openNode(page, "in1");
  await expect(page.locator("#node-dialog-ok")).toBeVisible();

  await page.screenshot({ path: "test-results/screenshots/real-image-editor.png" });
});
