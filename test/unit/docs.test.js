"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const nodeTypes = Object.keys(pkg["node-red"].nodes);
const { CODES } = require("../../lib/errors");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

test("README mentions every node type and every error code", async () => {
  for (const type of nodeTypes) assert.ok(readme.includes(type), `README missing node type ${type}`);
  for (const code of Object.keys(CODES)) assert.ok(readme.includes(code), `README missing error code ${code}`);
});

test("README prose has no semver-like version numbers outside fenced code blocks", async () => {
  const stripped = readme.replace(/```[\s\S]*?```/g, "");
  const match = stripped.match(/\bv?\d+\.\d+\.\d+\b/);
  assert.equal(match, null, `found version-like text: ${match && match[0]}`);
});

test("every data-help-name in nodes/*.html matches a registered node type", async () => {
  const dir = path.join(root, "nodes");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(dir, file), "utf8");
    for (const m of html.matchAll(/data-help-name="([^"]+)"/g)) {
      assert.ok(nodeTypes.includes(m[1]), `${file}: data-help-name "${m[1]}" is not a registered node type`);
    }
  }
});

test("every examples/*.json parses, uses only known node types, and carries no credentials", async () => {
  const coreTypes = ["inject", "debug", "comment", "tab", "catch", "function", "change", "switch"];
  const allowed = new Set([...nodeTypes, ...coreTypes]);
  const dir = path.join(root, "examples");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const flow = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    assert.ok(Array.isArray(flow), `${file} is not a flow array`);
    for (const node of flow) {
      assert.ok(allowed.has(node.type), `${file}: unexpected node type "${node.type}"`);
      assert.ok(!("credentials" in node), `${file}: node "${node.id}" carries a credentials key`);
    }
  }
});
