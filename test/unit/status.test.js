"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { STATUS, statusRenderer } = require("../../lib/status");

test("status texts carry reason and code; renderer drops repeats and reports a terminal transition once", () => {
  assert.equal(STATUS.disconnected("invalid token", 3500).text, "disconnected: invalid token (3500)");
  assert.equal(STATUS.disconnected().text, "disconnected");
  assert.equal(STATUS.unsubscribed("permission denied", 103).fill, "red");
  assert.equal(STATUS.invalidConfig("missing secret").text, "invalid config: missing secret");
  assert.equal(STATUS.connected.terminal, undefined);
  const calls = [];
  const errors = [];
  const render = statusRenderer({ status: (s) => calls.push(s), error: (e) => errors.push(e) });
  render(STATUS.connecting);
  render(STATUS.connecting);
  render(STATUS.connected);
  render(STATUS.disconnected("x", 1));
  render(STATUS.disconnected("x", 1));
  assert.deepEqual(
    calls.map((s) => s.text),
    ["connecting", "connected", "disconnected: unauthorized (1)"],
  );
  assert.deepEqual(Object.keys(calls[2]), ["fill", "shape", "text"], "terminal flag never reaches node.status");
  assert.deepEqual(errors, ["disconnected: unauthorized (1)"]);
});

test("disconnect labels cover documented terminal codes and SDK size/protocol failures", () => {
  const labels = [
    "invalid token",
    "bad request",
    "stale",
    "force disconnect",
    "connection limit",
    "channel limit",
    "inappropriate protocol",
    "permission denied",
    "not available",
    "too many errors",
  ];
  for (const [offset, label] of labels.entries())
    assert.equal(STATUS.disconnected("untrusted", 3500 + offset).text, `disconnected: ${label} (${3500 + offset})`);
  assert.equal(STATUS.disconnected("untrusted", 3).text, "disconnected: message size limit exceeded (3)");
  assert.equal(STATUS.disconnected("untrusted", 2).text, "disconnected: bad protocol (2)");
  assert.equal(STATUS.disconnected("untrusted", 4500).text, "disconnected (4500)");
  assert.equal(STATUS.unsubscribed("untrusted", 2000).text, "unsubscribed: server unsubscribe (2000)");
  assert.equal(STATUS.unsubscribed("untrusted", 102).text, "unsubscribed: unknown channel (102)");
});
