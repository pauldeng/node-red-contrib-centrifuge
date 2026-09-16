"use strict";
// Sends one request per input over the shared centrifuge-server connection: an RPC call, or a channel's history,
// presence, or presence stats. The result replaces msg.payload; see nodes/centrifuge-request.html for the contract.
const { coded, fromSdkError } = require("../lib/errors");
const { STATUS, statusRenderer } = require("../lib/status");
const { prepareCommand, prepareRequest } = require("../lib/payload");
const { validSelector, evaluateSelector, attachCommandLifecycle } = require("../lib/command-node");

const ACTIONS = new Set(["rpc", "history", "presence", "presence_stats"]);
const HISTORY_KEYS = new Set(["limit", "since", "reverse"]);
const POSITION_KEYS = new Set(["offset", "epoch"]);
// Node-RED Function nodes create objects in another realm; accept their Object.prototype too.
const isPlainObject = (v) => {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || (Object.getPrototypeOf(proto) === null && proto.constructor?.name === "Object");
};
const isSafeNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
// work(client, target, prepared) per action; `prepared` is what prepare() returned (rpc data or history options).
const COMMANDS = {
  rpc: (client, method, data) => client.rpc(method, data),
  history: (client, channel, opts) => client.history(channel, opts),
  presence: (client, channel) => client.presence(channel),
  presence_stats: (client, channel) => client.presenceStats(channel),
};

// Builds a fresh history options object from msg.payload; never passes the user-supplied object through.
function historyOptions(payload) {
  try {
    if (payload === undefined) return { limit: 100 };
    if (!isPlainObject(payload)) throw coded("INVALID_MESSAGE", "history options must be a plain object");
    if (Object.keys(payload).some((key) => !HISTORY_KEYS.has(key)))
      throw coded("INVALID_MESSAGE", "history options contain an unknown key");
    const { limit = 100, since, reverse } = payload;
    if (!isSafeNonNegInt(limit))
      throw coded("INVALID_MESSAGE", "history options: limit must be a non-negative safe integer");
    const opts = { limit };
    if (since !== undefined) {
      if (!isPlainObject(since)) throw coded("INVALID_MESSAGE", "history options: since must be a plain object");
      if (Object.keys(since).some((key) => !POSITION_KEYS.has(key)))
        throw coded("INVALID_MESSAGE", "history options: since contains an unknown key");
      const { offset, epoch } = since;
      if (!isSafeNonNegInt(offset))
        throw coded("INVALID_MESSAGE", "history options: since.offset must be a non-negative safe integer");
      if (typeof epoch !== "string" || !epoch)
        throw coded("INVALID_MESSAGE", "history options: since.epoch must be a non-empty string");
      opts.since = { offset, epoch };
    }
    if (reverse !== undefined) {
      if (typeof reverse !== "boolean") throw coded("INVALID_MESSAGE", "history options: reverse must be a boolean");
      // The SDK omits false from the wire command, so preflight the same shape.
      if (reverse) opts.reverse = true;
    }
    return opts;
  } catch (err) {
    const error = fromSdkError(err);
    if (error.code === "INVALID_MESSAGE") throw error;
    throw coded("INVALID_MESSAGE", "history options could not be read");
  }
}

module.exports = function (RED) {
  function CentrifugeRequestNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const render = statusRenderer(node);
    const action = config.action === undefined ? "rpc" : config.action;
    const targetType = config.targetType === undefined ? "msg" : config.targetType;
    const selector = config.target === undefined ? "topic" : config.target;
    const invalid = !ACTIONS.has(action) || !validSelector(selector, targetType);
    const server = RED.nodes.getNode(config.server);

    if (!server) render(STATUS.missingServer);
    else if (invalid) render(STATUS.invalidConfig("invalid target selector"));
    else server.register(node, render);

    attachCommandLifecycle(node, server, async (msg, signal) => {
      if (invalid) throw coded("INVALID_CONFIG", "invalid target selector");
      let target;
      const result = await server.run((client, arg) => COMMANDS[action](client, target, arg), {
        signal,
        prepare: async (check) => {
          target = await evaluateSelector(
            RED,
            node,
            msg,
            selector,
            targetType,
            action === "rpc" ? "method" : "channel",
          );
          check();
          if (action === "rpc")
            return prepareCommand("rpc", { method: target }, msg.payload, server.maxMessageSize).data;
          const opts = action === "history" ? historyOptions(msg.payload) : {};
          prepareRequest(action, { channel: target, ...opts }, server.maxMessageSize);
          return action === "history" ? opts : undefined; // presence actions ignore the payload
        },
      });
      msg.payload = action === "rpc" ? result.data : result;
      msg.centrifuge = action === "rpc" ? { action, method: target } : { action, channel: target };
    });
  }

  RED.nodes.registerType("centrifuge-request", CentrifugeRequestNode);
};
