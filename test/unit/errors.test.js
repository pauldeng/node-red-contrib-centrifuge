"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { coded, fromSdkError, CODES } = require("../../lib/errors");

test("coded: message, code, unknown code rejected", () => {
  const e = coded("TIMEOUT", "5000 ms");
  assert.equal(e.code, "TIMEOUT");
  assert.equal(e.message, `${CODES.TIMEOUT}: 5000 ms`);
  assert.throws(() => coded("NOPE"), /unknown error code/);
});

test("fromSdkError: table-driven mapping of SDK and server codes", () => {
  const cases = [
    [{ code: 1, message: "timeout" }, "TIMEOUT"],
    [{ code: 2, message: "transport closed" }, "NOT_CONNECTED"],
    [{ code: 3, message: "client disconnected" }, "NOT_CONNECTED"],
    [{ code: 11, message: "connection closed" }, "NOT_CONNECTED"],
    [{ code: 12, message: "bad configuration" }, "INVALID_CONFIG"],
    [{ code: 7, message: "subscription unsubscribed" }, "SDK_ERROR"],
    [{ code: 101, message: "unauthorized" }, "UNAUTHORIZED"],
    [{ code: 103, message: "permission denied" }, "PERMISSION_DENIED"],
    [{ code: 105, message: "already subscribed" }, "CONFIG_CONFLICT"],
    [{ code: 109, message: "token expired" }, "UNAUTHORIZED"],
    [{ code: 100, message: "internal server error", temporary: true }, "SERVER_ERROR"],
    [new Error("Subscription to the channel already exists"), "SDK_ERROR"],
    ["boom", "SDK_ERROR"],
  ];
  for (const [input, expected] of cases) assert.equal(fromSdkError(input).code, expected, JSON.stringify(input));
  const srv = fromSdkError({ code: 100, message: "x".repeat(500), temporary: true });
  assert.deepEqual(srv.centrifuge, { code: 100, temporary: true });
  assert.match(srv.message, /server code 100/);
  const already = coded("CLOSING");
  assert.equal(fromSdkError(already), already, "already-coded errors pass through");
});

test("Catch error descriptions identify known failures without echoing custom messages", () => {
  assert.match(fromSdkError({ code: 102, message: "secret-token" }).message, /server code 102: unknown channel$/);
  assert.match(fromSdkError({ code: 111, message: "secret-token" }).message, /server code 111: too many requests$/);
  const unknown = fromSdkError({ code: 999, message: "secret-token" });
  assert.equal(unknown.message, "server returned an error: server code 999");
  assert.match(fromSdkError({ code: 12, message: "secret-token" }).message, /client code 12: bad configuration$/);
});
