"use strict";
const { defineConfig } = require("@playwright/test");

// Projects map to docs/TESTING.md tiers: `editor` needs only a local Node-RED; the docker-* projects need Docker.
module.exports = defineConfig({
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { browserName: "chromium", trace: "retain-on-failure", screenshot: "off", video: "off" },
  outputDir: "test-results",
  projects: [
    { name: "editor", testDir: "test/e2e" },
    { name: "docker-ui", testDir: "test/docker/ui", timeout: 120_000 },
    { name: "docker-browser", testDir: "test/docker/browser", timeout: 180_000 },
  ],
});
