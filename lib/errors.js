"use strict";
// One closed set of error codes. Every code has one troubleshooting entry in the README.
// fromSdkError() maps centrifuge-js rejections ({code, message, temporary}) and thrown Errors onto it.
const CODES = Object.freeze({
  MISSING_SERVER: "no server configuration selected",
  INVALID_CONFIG: "invalid configuration",
  CONFIG_CONFLICT: "conflicting subscription configuration",
  NOT_CONNECTED: "not connected to the server",
  TIMEOUT: "operation exceeded its deadline",
  INVALID_MESSAGE: "message failed validation",
  CLOSING: "node is closing",
  UNAUTHORIZED: "unauthorized",
  PERMISSION_DENIED: "permission denied by the server",
  SERVER_ERROR: "server returned an error",
  SDK_ERROR: "client library error",
});

const localErrors = new WeakSet();

function coded(code, detail) {
  if (!Object.hasOwn(CODES, code)) throw new Error(`unknown error code ${code}`);
  const err = new Error(detail ? `${CODES[code]}: ${detail}` : CODES[code]);
  err.code = code;
  localErrors.add(err);
  return err;
}

// centrifuge-js client-side codes (src/codes.ts errorCodes); server command errors are >= 100.
const CLIENT_CODE = Object.freeze({
  1: "TIMEOUT",
  2: "NOT_CONNECTED", // transport closed
  3: "NOT_CONNECTED", // client disconnected
  4: "NOT_CONNECTED", // client closed
  5: "UNAUTHORIZED", // connect token
  6: "UNAUTHORIZED", // refresh token
  8: "UNAUTHORIZED", // subscription subscribe token
  9: "UNAUTHORIZED", // subscription refresh token
  10: "NOT_CONNECTED", // transport write error
  11: "NOT_CONNECTED", // connection closed
  12: "INVALID_CONFIG", // bad configuration
});
// Centrifugo server error codes: https://centrifugal.dev/docs/server/codes
const SERVER_CODE = Object.freeze({
  101: "UNAUTHORIZED",
  103: "PERMISSION_DENIED",
  105: "CONFIG_CONFLICT",
  109: "UNAUTHORIZED",
});

// Known descriptions keep Catch errors useful without trusting arbitrary proxy/SDK message text.
// Server labels: https://centrifugal.dev/docs/server/codes; SDK codes: centrifuge/build/codes.d.ts.
const SERVER_MESSAGES = Object.freeze({
  100: "internal server error",
  101: "unauthorized",
  102: "unknown channel",
  103: "permission denied",
  104: "method not found",
  105: "already subscribed",
  106: "limit exceeded",
  107: "bad request",
  108: "not available",
  109: "token expired",
  110: "expired",
  111: "too many requests",
  112: "unrecoverable position",
  113: "concurrent pagination",
});
const CLIENT_MESSAGES = Object.freeze({
  1: "timeout",
  2: "transport closed",
  3: "client disconnected",
  4: "client closed",
  5: "connection token failed",
  6: "refresh token failed",
  7: "subscription unsubscribed",
  8: "subscription token failed",
  9: "subscription refresh token failed",
  10: "transport write error",
  11: "connection closed",
  12: "bad configuration",
  13: "subscription state failed",
  14: "shared poll signature failed",
});

function fromSdkError(err) {
  if (localErrors.has(err)) return err;
  if (err && Number.isInteger(err.code)) {
    const server = err.code >= 100;
    const code = (server ? SERVER_CODE[err.code] : CLIENT_CODE[err.code]) ?? (server ? "SERVER_ERROR" : "SDK_ERROR");
    const label = (server ? SERVER_MESSAGES : CLIENT_MESSAGES)[err.code];
    const out = coded(code, `${server ? "server" : "client"} code ${err.code}${label ? `: ${label}` : ""}`);
    out.centrifuge = { code: err.code, temporary: err.temporary === true };
    return out;
  }
  return coded("SDK_ERROR");
}

module.exports = { CODES, coded, fromSdkError, SERVER_MESSAGES };
