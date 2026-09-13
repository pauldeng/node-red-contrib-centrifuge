"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { checkInstalledPackage } = require("../../scripts/check-installed-package");
const { checkPublishedPackage } = require("../../scripts/check-published-package");
const pkg = require("../../package.json");

const registrations = Object.keys(pkg["node-red"].nodes).map((type) => ({
  module: pkg.name,
  types: [type],
  enabled: true,
}));

async function fixture(t, source) {
  const userDir = await mkdtemp(path.join(tmpdir(), "release-gate-test-"));
  t.after(() => rm(userDir, { recursive: true, force: true }));
  const redPath = path.join(userDir, "process.cjs");
  await writeFile(redPath, source);
  return { userDir, redPath, timeoutMs: 3000 };
}

// A child-process/HTTP fixture tests the verifier, not Node-RED or transport behaviour.
function httpFixture({ status = 200, nodes = registrations, stall = false, announce = true } = {}) {
  return `const http = require("node:http");
    const server = http.createServer((_req, res) => {
      if (${stall}) return;
      res.writeHead(${status}, {"content-type": "application/json"});
      res.end(${JSON.stringify(JSON.stringify(nodes))});
    });
    server.listen(0, "127.0.0.1", () => {
      if (${announce}) console.log("Server now running at http://127.0.0.1:" + server.address().port + "/");
    });`;
}

for (const code of [0, 1]) {
  test(`installed-package gate rejects premature exit ${code}`, async (t) => {
    const opts = await fixture(t, `process.stderr.write("startup failed\\n"); process.exit(${code});`);
    await assert.rejects(checkInstalledPackage(opts), /exited before verification completed.*\nstartup failed/s);
  });
}

test("installed-package gate accepts exactly the enabled expected registrations", async (t) => {
  await checkInstalledPackage(await fixture(t, httpFixture()));
});

for (const [name, response, error] of [
  ["HTTP failure", { status: 503 }, /HTTP 503/],
  ["missing types", { nodes: [] }, /node types differ/],
  [
    "wrong types with the same count",
    { nodes: registrations.map((n) => ({ ...n, types: ["wrong"] })) },
    /node types differ/,
  ],
  ["disabled registration", { nodes: registrations.map((n) => ({ ...n, enabled: false })) }, /disabled or failed/],
  ["load error", { nodes: registrations.map((n) => ({ ...n, err: "failed" })) }, /disabled or failed/],
]) {
  test(`installed-package gate rejects ${name}`, async (t) => {
    await assert.rejects(checkInstalledPackage(await fixture(t, httpFixture(response))), error);
  });
}

for (const [name, response] of [
  ["missing readiness", { announce: false }],
  ["stalled HTTP", { stall: true }],
]) {
  test(`installed-package deadline bounds ${name} and stops the child`, async (t) => {
    const opts = await fixture(t, httpFixture(response));
    await assert.rejects(checkInstalledPackage({ ...opts, timeoutMs: 500 }), /verification timed out/);
  });
}

const metadata = () => ({
  version: pkg.version,
  "dist.tarball": "https://registry.npmjs.org/package.tgz",
  "dist.attestations": {
    url: "https://registry.npmjs.org/attestations/package",
    provenance: { predicateType: "https://slsa.dev/provenance/v1" },
  },
});

test("registry gate requires the release version, tarball and provenance metadata", () => {
  assert.doesNotThrow(() => checkPublishedPackage(metadata()));
  for (const field of ["version", "dist.tarball", "dist.attestations"]) {
    const missing = metadata();
    delete missing[field];
    assert.throws(() => checkPublishedPackage(missing));
  }
  const wrongVersion = { ...metadata(), version: "0.0.0-review" };
  assert.throws(() => checkPublishedPackage(wrongVersion), /version differs/);
  const noProvenance = metadata();
  delete noProvenance["dist.attestations"].provenance;
  assert.throws(() => checkPublishedPackage(noProvenance), /provenance attestation/);
  const wrongPredicate = metadata();
  wrongPredicate["dist.attestations"].provenance.predicateType = "https://example.com/other";
  assert.throws(() => checkPublishedPackage(wrongPredicate), /unexpected predicate/);
});
