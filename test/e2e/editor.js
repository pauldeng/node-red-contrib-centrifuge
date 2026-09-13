"use strict";
// Editor helpers: readiness by real state, programmatic dialog opening (no canvas double-click race),
// tray animation settled, config-node tray ids, overflow measurement, both themes.
const { expect } = require("@playwright/test");

const THEMES = ["light", "dark"];
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 800, height: 600 },
];

const settled = (page) =>
  page.waitForFunction(() =>
    [...document.querySelectorAll(".red-ui-tray")].every((t) =>
      t.getAnimations({ subtree: true }).every((a) => a.playState !== "running"),
    ),
  );

const waitReady = (page) =>
  page.waitForFunction(
    () =>
      window.RED?.workspaces?.active() &&
      getComputedStyle(document.querySelector("#red-ui-loading-progress")).display === "none",
  );
async function gotoEditor(page, nr, theme = "light") {
  await page.addInitScript((t) => localStorage.setItem("view-dark-theme", t), theme);
  await page.goto(nr.base + "/");
  await waitReady(page);
}
// A full reload re-fetches flows (and credentials) from the runtime, so a saved password re-appears as the
// "__PWRD__" sentinel instead of the plaintext the in-memory client still held right after saving it.
async function reloadEditor(page) {
  await page.reload();
  await waitReady(page);
}
// Saving a dialog only updates the client-side node model; RED.nodes survives a reopen in the same page either
// way, but only a real Deploy persists it to the runtime (needed before a reload, or before another page/session
// could see it).
async function deployFromEditor(page, nr) {
  const after = nr.lines.length;
  await page.evaluate(() => RED.actions.invoke("core:deploy-flows"));
  await nr.waitForLog(/Started (flows|modified flows|modified nodes)/, { after });
}
async function openNode(page, id) {
  await page.evaluate((id) => RED.editor.edit(RED.nodes.node(id)), id);
  await expect(page.locator("#node-dialog-ok")).toBeVisible();
  await settled(page);
}
async function openConfig(page, type, id = "_ADD_") {
  await page.evaluate(([t, i]) => RED.editor.editConfig("", t, i), [type, id]);
  await expect(page.locator("#node-config-dialog-ok")).toBeVisible();
  await settled(page);
}
async function closeDialog(page, { save = true, config = false } = {}) {
  const sel = `#node-${config ? "config-" : ""}dialog-${save ? "ok" : "cancel"}`;
  await expect(async () => {
    // the editor can swallow a click during a redraw; retry the whole gesture
    if ((await page.locator(sel).count()) === 0) return;
    await page.locator(sel).click({ timeout: 2000 });
    await page.waitForSelector(sel, { state: "detached", timeout: 2000 });
  }).toPass({ timeout: 20_000 });
}
async function assertNoOverflow(page) {
  const over = await page.evaluate(
    () =>
      document.querySelector(".red-ui-tray-body").scrollWidth -
      document.querySelector(".red-ui-tray-body-wrapper").clientWidth,
  );
  expect(over, `tray overflows by ${over}px`).toBeLessThanOrEqual(20);
}
module.exports = {
  THEMES,
  VIEWPORTS,
  gotoEditor,
  reloadEditor,
  deployFromEditor,
  openNode,
  openConfig,
  closeDialog,
  assertNoOverflow,
  settled,
};
