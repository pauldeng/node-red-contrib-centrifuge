"use strict";
// Publishes msg.payload to a channel over the shared centrifuge-server connection. No offline queue: while
// reconnecting a publish waits the server node's Timeout then fails TIMEOUT; a terminal connection fails NOT_CONNECTED.
const { promisify } = require("node:util");
const { coded, fromSdkError } = require("../lib/errors");
const { STATUS, statusRenderer } = require("../lib/status");
const { prepareCommand } = require("../lib/payload");
const CHANNEL_TYPES = new Set(["msg", "flow", "global", "str", "env", "jsonata"]);

module.exports = function (RED) {
  const evaluate = promisify(RED.util.evaluateNodeProperty);

  function CentrifugeOutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const render = statusRenderer(node);
    const channelType = config.channelType === undefined ? "msg" : config.channelType;
    const selector = config.channel === undefined ? "topic" : config.channel;
    const invalid = !CHANNEL_TYPES.has(channelType) || typeof selector !== "string" || !selector.trim();
    const server = RED.nodes.getNode(config.server);
    const inflight = new Map(); // AbortController -> settlement promise, so close() can await every in-flight input
    let closing = false;

    if (!server) render(STATUS.missingServer);
    else if (invalid) render(STATUS.invalidConfig("invalid channel selector"));
    else server.register(node, render);

    node.on("input", async (msg, send, done) => {
      const ac = new AbortController();
      const settle = Promise.withResolvers();
      inflight.set(ac, settle.promise);
      try {
        if (closing) throw coded("CLOSING");
        if (!server) throw coded("MISSING_SERVER");
        if (invalid) throw coded("INVALID_CONFIG", "invalid channel selector");
        let channel;
        await server.run((client, data) => client.publish(channel, data), {
          signal: ac.signal,
          prepare: async (check) => {
            try {
              channel = await evaluate(selector, channelType, node, msg);
            } catch {
              throw coded("INVALID_MESSAGE", "channel evaluation failed");
            }
            check();
            if (typeof channel !== "string" || !channel.trim())
              throw coded("INVALID_MESSAGE", "channel must be a non-empty string");
            return prepareCommand("publish", { channel }, msg.payload, server.maxMessageSize).data;
          },
        });
        if (closing) throw coded("CLOSING");
        msg.centrifuge = { action: "publish", channel };
        send(msg);
        done();
      } catch (err) {
        // Teardown is expected and must not emit Catch/log noise. New inputs received after close still fail.
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

  RED.nodes.registerType("centrifuge-out", CentrifugeOutNode);
};
