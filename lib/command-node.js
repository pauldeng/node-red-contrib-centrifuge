"use strict";
// Shared per-input lifecycle for command nodes (centrifuge-out, centrifuge-request): inflight tracking so close()
// can drain every in-flight input, quiet settlement when an input is aborted by close, and TypedInput selector
// evaluation. Shared with centrifuge-out.js; preserve its existing settlement behaviour.
const { promisify } = require("node:util");
const { coded, fromSdkError } = require("./errors");

const SELECTOR_TYPES = new Set(["msg", "flow", "global", "str", "env", "jsonata"]);

function validSelector(selector, type) {
  return SELECTOR_TYPES.has(type) && typeof selector === "string" && selector.trim() !== "";
}

// Evaluates a TypedInput selector against msg and requires a non-empty string result (a channel or an RPC method).
async function evaluateSelector(RED, node, msg, selector, type, what) {
  const evaluate = promisify(RED.util.evaluateNodeProperty);
  let value;
  try {
    value = await evaluate(selector, type, node, msg);
  } catch {
    throw coded("INVALID_MESSAGE", `${what} evaluation failed`);
  }
  if (typeof value !== "string" || !value.trim()) throw coded("INVALID_MESSAGE", `${what} must be a non-empty string`);
  return value;
}

// Wires node.on("input") + node.on("close"). handle(msg, signal) performs the request and mutates msg on success;
// on failure it throws a coded() error. Success sends msg and calls done(); failure calls done(error), except a
// close-triggered abort settles quietly (no Catch/log noise) since new inputs after close still fail loudly.
function attachCommandLifecycle(node, server, handle) {
  const inflight = new Map(); // AbortController -> settlement promise
  let closing = false;

  node.on("input", async (msg, send, done) => {
    const ac = new AbortController();
    const settle = Promise.withResolvers();
    inflight.set(ac, settle.promise);
    try {
      if (closing) throw coded("CLOSING");
      if (!server) throw coded("MISSING_SERVER");
      await handle(msg, ac.signal);
      if (closing) throw coded("CLOSING");
      send(msg);
      done();
    } catch (err) {
      const error = fromSdkError(err);
      done(ac.signal.aborted && error.code === "CLOSING" ? undefined : error);
    } finally {
      inflight.delete(ac);
      settle.resolve();
    }
  });

  node.on("close", async (_removed, done) => {
    closing = true;
    for (const ac of inflight.keys()) ac.abort(coded("CLOSING"));
    await Promise.allSettled(inflight.values());
    server?.deregister(node);
    node.status({});
    done();
  });
}

module.exports = { SELECTOR_TYPES, validSelector, evaluateSelector, attachCommandLifecycle };
