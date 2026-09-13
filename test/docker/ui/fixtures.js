"use strict";
// Tier 4 (docs/TESTING.md): one real Centrifugo container + one real Node-RED per test. `nr` depends on `srv` so
// Playwright tears down in reverse order (Node-RED stopped before the container it talks to).
const base = require("@playwright/test");
const path = require("node:path");
const { startNodeRed } = require("../../helpers/node-red");
const { startCentrifugoContainer } = require("../../helpers/docker");

exports.test = base.test.extend({
  // ping_interval must exceed pong_timeout (Centrifugo refuses to start otherwise); 3s ping means a `pause()`
  // stall is detected in ~13s (server ping interval + the client SDK's ~10s no-ping allowance).

  srv: async ({}, use) => {
    const srv = await startCentrifugoContainer({ config: { client: { ping_interval: "3s", pong_timeout: "1s" } } });
    try {
      await use(srv);
    } finally {
      await srv.stop();
    }
  },
  // eslint-disable-next-line no-unused-vars -- destructured only to make Playwright tear this down before srv
  nr: async ({ srv }, use) => {
    const nr = await startNodeRed({ packageDir: path.resolve(__dirname, "../../..") });
    try {
      await use(nr);
    } finally {
      await nr.stop();
    }
  },
});
exports.expect = base.expect;
