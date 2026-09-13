"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readdir } = require("node:fs/promises");
const os = require("node:os");
const { startCentrifugoContainer, docker, waitForLogLine } = require("../../helpers/docker");

const temporaryDirs = async () =>
  (await readdir(os.tmpdir())).filter((name) => name.startsWith(`nrc-docker-${process.pid}-`)).sort();

test("container setup failure removes its resources without deleting a name collision", async (t) => {
  const srv = await startCentrifugoContainer();
  t.after(() => srv.stop());
  const before = await temporaryDirs();
  await assert.rejects(startCentrifugoContainer({ name: srv.name }), /already in use/);
  assert.equal(await docker("inspect", "--format", "{{.State.Running}}", srv.name), "true");
  assert.deepEqual(await temporaryDirs(), before, "failed create removed its temporary configuration");
});

test("a process that exits during startup fails promptly and is cleaned up", async () => {
  const name = `nrc-invalid-${process.pid}`;
  const before = await temporaryDirs();
  const start = performance.now();
  await assert.rejects(
    startCentrifugoContainer({ name, config: { http_server: { port: -1 } } }),
    /not ready|no published port/,
  );
  assert.ok(performance.now() - start < 10000, "process exit must not wait for the 30-second ready deadline");
  await assert.rejects(docker("inspect", name), /no such/i);
  assert.deepEqual(await temporaryDirs(), before);
});

test("missing container log stream rejects when docker exits", async () => {
  const start = performance.now();
  await assert.rejects(waitForLogLine(`nrc-missing-${process.pid}`, /ready/, 30000), /docker logs ended/);
  assert.ok(performance.now() - start < 5000);
});
