"use strict";
// One status vocabulary for the whole package. The connection owner computes it; consumers only render it.
// Yellow ring = transient (the SDK is retrying). Red ring = terminal or configuration; fix the cause and redeploy.
const { SERVER_MESSAGES } = require("./errors");
const S = (fill, shape, text, extra = {}) => Object.freeze({ fill, shape, text, ...extra });
const suffix = (reason, code) => {
  const r = typeof reason === "string" && reason ? `: ${reason.slice(0, 60)}` : "";
  return Number.isInteger(code) ? `${r} (${code})` : r;
};
// Only known, local labels reach status. Wire reasons are untrusted text (including proxy diagnostics).
// Centrifugo documented disconnect/ unsubscribe codes plus the pinned SDK's local event codes.
// https://centrifugal.dev/docs/server/codes; centrifuge/build/codes.d.ts; probe P10 for local code 3.
const DISCONNECT_REASONS = Object.freeze({
  0: "disconnect called",
  1: "unauthorized",
  2: "bad protocol",
  3: "message size limit exceeded",
  3000: "connection closed",
  3001: "shutdown",
  3004: "internal server error",
  3005: "connection expired",
  3006: "subscription expired",
  3008: "slow",
  3009: "write error",
  3010: "insufficient state",
  3011: "force reconnect",
  3012: "no pong",
  3013: "too many requests",
  3014: "state invalidated",
  3500: "invalid token",
  3501: "bad request",
  3502: "stale",
  3503: "force disconnect",
  3504: "connection limit",
  3505: "channel limit",
  3506: "inappropriate protocol",
  3507: "permission denied",
  3508: "not available",
  3509: "too many errors",
});
const UNSUBSCRIBE_REASONS = Object.freeze({
  ...SERVER_MESSAGES,
  0: "unsubscribe called",
  1: "unauthorized",
  2: "client closed",
  2000: "server unsubscribe",
  2500: "insufficient state",
  2501: "subscription expired",
  2502: "state invalidated",
});
const STATUS = Object.freeze({
  connecting: S("yellow", "ring", "connecting"),
  connected: S("green", "dot", "connected"),
  disconnected: (_reason, code) =>
    S("red", "ring", `disconnected${suffix(DISCONNECT_REASONS[code], code)}`, { terminal: true }),
  invalidConfig: (detail) => S("red", "ring", `invalid config${suffix(detail)}`, { terminal: true }),
  missingServer: S("red", "ring", "missing server", { terminal: true }),
  subscribing: S("yellow", "ring", "subscribing"),
  subscribed: S("green", "dot", "subscribed"),
  unsubscribed: (_reason, code) =>
    S("red", "ring", `unsubscribed${suffix(UNSUBSCRIBE_REASONS[code], code)}`, { terminal: true }),
  awaitingServer: S("yellow", "ring", "awaiting server subscription"),
});

// Render only on change: identical consecutive statuses are dropped so hot paths never flood the editor.
// A terminal transition is also reported once through node.error (no message, so it is logged, not caught).
function statusRenderer(node) {
  let last = "";
  return (status) => {
    const key = `${status.fill}|${status.shape}|${status.text}`;
    if (key === last) return;
    last = key;
    node.status({ fill: status.fill, shape: status.shape, text: status.text });
    if (status.terminal) node.error(status.text);
  };
}

module.exports = { STATUS, statusRenderer };
