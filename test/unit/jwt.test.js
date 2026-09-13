"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { signHS256, connectionToken, subscriptionToken } = require("../../lib/jwt");

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString());

test("connectionToken: HS256 structure, claims, verifiable signature", () => {
  const now = 1_700_000_000;
  const token = connectionToken({ secret: "s3cret", sub: "node-red", ttl: 60, channels: ["news"], now });
  const [h, b, sig] = token.split(".");
  assert.equal(token.split(".").length, 3);
  assert.deepEqual(decode(h), { alg: "HS256", typ: "JWT" });
  assert.deepEqual(decode(b), { sub: "node-red", iat: now, exp: now + 60, channels: ["news"] });
  assert.equal(sig, createHmac("sha256", "s3cret").update(`${h}.${b}`).digest("base64url"));
  assert.doesNotMatch(token, /[+/=]/, "base64url without padding");
});

test("connectionToken: empty channels omit the claim; anonymous sub allowed; bad secret rejected", () => {
  assert.equal("channels" in decode(connectionToken({ secret: "x", channels: [], now: 1 }).split(".")[1]), false);
  assert.equal(decode(connectionToken({ secret: "x", sub: "", now: 1 }).split(".")[1]).sub, "");
  assert.throws(() => signHS256({}, ""), /non-empty/);
  assert.throws(() => signHS256({}, undefined), /non-empty/);
});

test("subscriptionToken: requires channel and carries sub + channel", () => {
  const claims = decode(
    subscriptionToken({ secret: "x", sub: "u", channel: "locked:x", ttl: 5, now: 10 }).split(".")[1],
  );
  assert.deepEqual(claims, { sub: "u", channel: "locked:x", iat: 10, exp: 15 });
  assert.throws(() => subscriptionToken({ secret: "x", channel: "" }), /channel/);
});
