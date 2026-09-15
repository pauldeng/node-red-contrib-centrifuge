"use strict";
// Publishes msg.payload to a channel over the shared centrifuge-server connection. No offline queue: while
// reconnecting a publish waits the server node's Timeout then fails TIMEOUT; a terminal connection fails NOT_CONNECTED.
const { coded } = require("../lib/errors");
const { STATUS, statusRenderer } = require("../lib/status");
const { prepareCommand } = require("../lib/payload");
const { validSelector, evaluateSelector, attachCommandLifecycle } = require("../lib/command-node");

module.exports = function (RED) {
  function CentrifugeOutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const render = statusRenderer(node);
    const channelType = config.channelType === undefined ? "msg" : config.channelType;
    const selector = config.channel === undefined ? "topic" : config.channel;
    const invalid = !validSelector(selector, channelType);
    const server = RED.nodes.getNode(config.server);

    if (!server) render(STATUS.missingServer);
    else if (invalid) render(STATUS.invalidConfig("invalid channel selector"));
    else server.register(node, render);

    attachCommandLifecycle(node, server, async (msg, signal) => {
      if (invalid) throw coded("INVALID_CONFIG", "invalid channel selector");
      let channel;
      await server.run((client, data) => client.publish(channel, data), {
        signal,
        prepare: async (check) => {
          channel = await evaluateSelector(RED, node, msg, selector, channelType, "channel");
          check();
          return prepareCommand("publish", { channel }, msg.payload, server.maxMessageSize).data;
        },
      });
      msg.centrifuge = { action: "publish", channel };
    });
  }

  RED.nodes.registerType("centrifuge-out", CentrifugeOutNode);
};
