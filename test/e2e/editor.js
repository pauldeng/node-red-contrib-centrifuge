"use strict";
// Editor helpers: readiness by real state, programmatic dialog opening (no canvas double-click race),
// tray animation settled, config-node tray ids, overflow measurement, both themes.
const { expect } = require("@playwright/test");

const THEMES = ["light", "dark"];
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 800, height: 600 },
];

// Poll on an interval, not requestAnimationFrame: a headless tab that Chromium treats as hidden can throttle rAF
// indefinitely, which stalled an editor readiness wait in CI while the page had in fact finished loading.
const POLL = { polling: 100 };
const settled = (page) =>
  page.waitForFunction(
    () =>
      [...document.querySelectorAll(".red-ui-tray")].every((t) =>
        t.getAnimations({ subtree: true }).every((a) => a.playState !== "running"),
      ),
    undefined,
    POLL,
  );

const isReady = () =>
  Boolean(window.RED?.workspaces?.active()) &&
  getComputedStyle(document.querySelector("#red-ui-loading-progress") ?? document.body).display === "none";
// Bounded, and on failure the error says what the page and the runtime were doing instead of just "timeout".
async function waitReady(page, nr) {
  try {
    await page.waitForFunction(isReady, undefined, { ...POLL, timeout: 60_000 });
  } catch (err) {
    let state;
    try {
      state = await page.evaluate(() => ({
        readyState: document.readyState,
        hasRED: Boolean(window.RED),
        activeWorkspace: window.RED?.workspaces?.active?.() ?? null,
        overlay: document.querySelector("#red-ui-loading-progress")?.innerText?.trim().slice(0, 200) ?? "(absent)",
        notifications: [...document.querySelectorAll(".red-ui-notification")].map((n) =>
          n.innerText.trim().slice(0, 120),
        ),
      }));
    } catch (evaluateError) {
      state = { evaluateFailed: String(evaluateError.message) };
    }
    const runtime = nr?.lines?.slice(-12) ?? [];
    throw new Error(
      `editor did not become ready: ${JSON.stringify(state)}; last runtime log lines:\n${runtime.join("\n")}`,
      { cause: err },
    );
  }
}
async function gotoEditor(page, nr, theme = "light") {
  await page.addInitScript((t) => localStorage.setItem("view-dark-theme", t), theme);
  await page.goto(nr.base + "/");
  await waitReady(page, nr);
}
// A full reload re-fetches flows (and credentials) from the runtime, so a saved password re-appears as the
// "__PWRD__" sentinel instead of the plaintext the in-memory client still held right after saving it.
async function reloadEditor(page, nr) {
  await page.reload();
  await waitReady(page, nr);
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
