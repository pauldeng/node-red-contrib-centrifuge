"use strict";
// centrifuge-server config dialog: conditional auth rows, persistence across save/reopen, validator feedback.
const { test, expect } = require("./fixtures");
const E = require("./editor");

test("server config dialog: conditional rows, persistence, validation", async ({ page, nr }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await E.gotoEditor(page, nr, "light");
  await E.openConfig(page, "centrifuge-server", "_ADD_");

  // default auth is hmac: hmac rows visible, token row hidden
  await expect(page.locator("#node-config-input-secret")).toBeVisible();
  await expect(page.locator("#node-config-input-user")).toBeVisible();
  await expect(page.locator("#node-config-input-channels")).toBeVisible();
  await expect(page.locator("#node-config-input-ttl")).toBeVisible();
  await expect(page.locator("#node-config-input-token")).toBeHidden();

  await page.fill("#node-config-input-url", "wss://example.invalid/connection/websocket");
  await page.fill("#node-config-input-user", "svc");
  await page.fill("#node-config-input-channels", "news\nalerts");
  await page.fill("#node-config-input-ttl", "600");
  await page.fill("#node-config-input-timeout", "2500");
  await page.fill("#node-config-input-maxMessageSize", "32768");
  await page.fill("#node-config-input-secret", "s");

  // switch to token auth: hmac rows hide, token row shows
  await page.selectOption("#node-config-input-auth", "token");
  await expect(page.locator("#node-config-input-secret")).toBeHidden();
  await expect(page.locator("#node-config-input-user")).toBeHidden();
  await expect(page.locator("#node-config-input-channels")).toBeHidden();
  await expect(page.locator("#node-config-input-ttl")).toBeHidden();
  await expect(page.locator("#node-config-input-token")).toBeVisible();

  // switch back to hmac
  await page.selectOption("#node-config-input-auth", "hmac");
  await expect(page.locator("#node-config-input-secret")).toBeVisible();
  await expect(page.locator("#node-config-input-token")).toBeHidden();

  await expect(page.locator(".red-ui-tray-content .input-error")).toHaveCount(0);

  // validator: ttl outside 60-86400 flags input-error, restoring a valid value clears it.
  // fill() alone only dispatches "input"; Node-RED's field validation listens for "change", which a
  // number input only emits on blur in a real browser, so press Tab to blur after each edit.
  await page.fill("#node-config-input-ttl", "10");
  await page.keyboard.press("Tab");
  await expect(page.locator("#node-config-input-ttl")).toHaveClass(/input-error/);
  await page.selectOption("#node-config-input-auth", "none");
  await expect(page.locator("#node-config-input-ttl")).not.toHaveClass(/input-error/);
  await page.selectOption("#node-config-input-auth", "hmac");
  await expect(page.locator("#node-config-input-ttl")).toHaveClass(/input-error/);
  await page.fill("#node-config-input-ttl", "600");
  await page.keyboard.press("Tab");
  await expect(page.locator("#node-config-input-ttl")).not.toHaveClass(/input-error/);
  await expect(page.locator(".red-ui-tray-content .input-error")).toHaveCount(0);

  await page.fill("#node-config-input-url", "wss://example.invalid/connection/websocket#");
  await page.keyboard.press("Tab");
  await expect(page.locator("#node-config-input-url")).toHaveClass(/input-error/);
  await page.fill("#node-config-input-url", "wss://example.invalid/connection/websocket");
  await page.keyboard.press("Tab");
  await expect(page.locator("#node-config-input-url")).not.toHaveClass(/input-error/);

  await E.closeDialog(page, { save: true, config: true });

  const id = await page.evaluate(() => {
    let found;
    RED.nodes.eachConfig((n) => {
      if (n.type === "centrifuge-server") found = n.id;
    });
    return found;
  });
  expect(id).toBeTruthy();

  // deploy so the node exists in the runtime, then reload so credentials come back redacted rather than
  // held in memory from the edit just made
  await E.deployFromEditor(page, nr);
  await E.reloadEditor(page);
  await E.openConfig(page, "centrifuge-server", id);
  await expect(page.locator("#node-config-input-url")).toHaveValue("wss://example.invalid/connection/websocket");
  await expect(page.locator("#node-config-input-auth")).toHaveValue("hmac");
  await expect(page.locator("#node-config-input-user")).toHaveValue("svc");
  await expect(page.locator("#node-config-input-channels")).toHaveValue("news\nalerts");
  await expect(page.locator("#node-config-input-ttl")).toHaveValue("600");
  await expect(page.locator("#node-config-input-timeout")).toHaveValue("2500");
  await expect(page.locator("#node-config-input-maxMessageSize")).toHaveValue("32768");
  // credentials are never read back in plaintext; Node-RED marks a set password with this sentinel
  await expect(page.locator("#node-config-input-secret")).toHaveValue("__PWRD__");
  await expect(page.locator(".red-ui-tray-content .input-error")).toHaveCount(0);
  await E.closeDialog(page, { save: false, config: true });
});
