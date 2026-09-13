"use strict";
// Release gate: verify normal package discovery from an already installed, isolated Node-RED user directory.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { writeFile } = require("node:fs/promises");
const path = require("node:path");
const pkg = require("../package.json");

async function checkInstalledPackage({ userDir, redPath = require.resolve("node-red/red.js"), timeoutMs = 90_000 }) {
  const settings = path.join(userDir, "release-settings.js");
  await writeFile(settings, 'module.exports = { uiHost: "127.0.0.1", uiPort: 0, telemetry: { enabled: false } };\n');
  const child = spawn(process.execPath, [redPath, "-u", userDir, "-s", settings], {
    cwd: userDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = Promise.withResolvers();
  const failed = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const controller = new AbortController();
  let logs = "";
  const fail = (error) => {
    controller.abort(error);
    failed.reject(error);
  };
  child.on("error", fail);
  child.on("close", (code, signal) => {
    closed.resolve();
    fail(new Error(`Node-RED exited before verification completed (${signal ?? code}); last logs:\n${logs}`));
  });
  const onData = (data) => {
    logs = (logs + data).slice(-4000);
    const match = logs.match(/Server now running at (http:\/\/127\.0\.0\.1:\d+)\//);
    if (match) ready.resolve(match[1]);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  // Keep this deadline referenced: child exit or missing readiness must never become an implicit success.
  const timer = setTimeout(() => fail(new Error(`Node-RED verification timed out; last logs:\n${logs}`)), timeoutMs);
  try {
    await Promise.race([
      failed.promise,
      (async () => {
        const base = await ready.promise;
        const response = await fetch(`${base}/nodes`, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Node-RED /nodes returned HTTP ${response.status}`);
        const nodes = await response.json();
        const ours = nodes.filter((node) => node.module === pkg.name);
        const types = ours.flatMap((node) => node.types).sort();
        assert.deepEqual(types, Object.keys(pkg["node-red"].nodes).sort(), "installed node types differ");
        assert.ok(
          ours.every((node) => node.enabled && !node.err),
          "an installed node is disabled or failed to load",
        );
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await closed.promise;
      } finally {
        clearTimeout(force);
      }
    } else await closed.promise;
  }
}

if (require.main === module) {
  void (async () => {
    try {
      if (!process.argv[2]) throw new Error("usage: node scripts/check-installed-package.js <user-directory>");
      await checkInstalledPackage({ userDir: path.resolve(process.argv[2]) });
      console.log("Installed package registers every expected node");
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
    }
  })();
}

module.exports = { checkInstalledPackage };
