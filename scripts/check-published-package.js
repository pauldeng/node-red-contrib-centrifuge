"use strict";
// Validate the JSON returned by npm view <name>@<version> version dist.tarball dist.attestations --json.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const pkg = require("../package.json");

function checkPublishedPackage(metadata) {
  assert.equal(metadata?.version, pkg.version, "registry version differs from the release");
  assert.ok(metadata["dist.tarball"]?.startsWith("https://"), "registry tarball URL is missing");
  const attestation = metadata["dist.attestations"];
  assert.ok(attestation?.url?.startsWith("https://"), "registry attestation URL is missing");
  assert.equal(
    attestation.provenance?.predicateType,
    "https://slsa.dev/provenance/v1",
    "registry provenance attestation is missing or has an unexpected predicate type",
  );
}

if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error("usage: node scripts/check-published-package.js <registry-metadata.json>");
    checkPublishedPackage(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
    console.log(`Registry confirms ${pkg.name}@${pkg.version} with provenance metadata`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
}

module.exports = { checkPublishedPackage };
