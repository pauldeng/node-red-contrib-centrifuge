"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validate, parseChannels } = require("../../lib/connection");

test("validate: defaults, url rules, auth credentials, ranges", () => {
  const ok = validate({ url: "ws://localhost:8000/connection/websocket?x=1", secret: "s" });
  assert.deepEqual(
    { ...ok, secret: undefined },
    {
      url: "ws://localhost:8000/connection/websocket?x=1",
      auth: "hmac",
      user: "node-red",
      channels: [],
      ttl: 3600,
      timeout: 5000,
      maxMessageSize: 65536,
      secret: undefined,
      token: undefined,
    },
  );
  assert.equal(
    validate({ url: "wss://h/", auth: "hmac", secret: "s", user: "" }).user,
    "",
    "empty user is a valid anonymous subject",
  );
  const bad = (o) =>
    assert.throws(
      () => validate({ url: "ws://h/", secret: "s", ...o }),
      (e) => e.code === "INVALID_CONFIG",
      JSON.stringify(o),
    );
  bad({ url: "http://h/" });
  bad({ url: "ws://user:pw@h/" });
  bad({ url: "ws://h/#frag" });
  bad({ url: "nope" });
  bad({ auth: "basic" });
  bad({ auth: "hmac", secret: "" });
  bad({ auth: "token", token: undefined });
  bad({ ttl: 59 });
  bad({ timeout: 99 });
  bad({ timeout: "5000.5" });
  bad({ maxMessageSize: 0 });
  assert.equal(
    validate({ url: "ws://h/", secret: "s", timeout: "250" }).timeout,
    250,
    "numeric strings from the editor are accepted",
  );
});

test("parseChannels: one per line, trimmed, deduplicated, commas preserved", () => {
  assert.deepEqual(parseChannels(" news \r\n\nalerts\npersonal:#17,42\nnews"), ["news", "alerts", "personal:#17,42"]);
  assert.deepEqual(parseChannels(""), []);
  assert.deepEqual(parseChannels(undefined), []);
  assert.throws(
    () => parseChannels(["a"]),
    (e) => e.code === "INVALID_CONFIG",
  );
});
