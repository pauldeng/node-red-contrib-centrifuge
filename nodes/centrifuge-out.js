"use strict";
// Publishes msg.payload to a channel, or writes/removes a key on a map channel (Centrifugo experimental map
// subscriptions), over the shared centrifuge-server connection. No offline queue: while reconnecting an operation
// waits the server node's Timeout then fails TIMEOUT; a terminal connection fails NOT_CONNECTED.
const { coded } = require("../lib/errors");
const { STATUS, statusRenderer } = require("../lib/status");
const { prepareCommand, prepareRequest } = require("../lib/payload");
const { validSelector, evaluateSelector, attachCommandLifecycle } = require("../lib/command-node");

const MODES = new Set(["publish", "map_publish", "map_remove"]);

module.exports = function (RED) {
  function CentrifugeOutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const render = statusRenderer(node);
    const channelType = config.channelType === undefined ? "msg" : config.channelType;
    const selector = config.channel === undefined ? "topic" : config.channel;
    const invalidChannel = !validSelector(selector, channelType);
    const mode = config.mode === undefined ? "publish" : config.mode;
    const invalidMode = !MODES.has(mode);
    const mapMode = mode === "map_publish" || mode === "map_remove";
    const keyType = config.keyType === undefined ? "msg" : config.keyType;
    const keySelector = config.key === undefined ? "key" : config.key;
    const invalidKey = mapMode && !validSelector(keySelector, keyType);
    const server = RED.nodes.getNode(config.server);

    if (!server) render(STATUS.missingServer);
    else if (invalidChannel) render(STATUS.invalidConfig("invalid channel selector"));
    else if (invalidMode) render(STATUS.invalidConfig("invalid mode"));
    else if (invalidKey) render(STATUS.invalidConfig("invalid key selector"));
    else server.register(node, render);

    attachCommandLifecycle(node, server, async (msg, signal) => {
      if (invalidChannel) throw coded("INVALID_CONFIG", "invalid channel selector");
      if (invalidMode) throw coded("INVALID_CONFIG", "invalid mode");
      if (invalidKey) throw coded("INVALID_CONFIG", "invalid key selector");
      let channel, key;
      await server.run(
        (client, data) => {
          if (mode === "map_remove") return client.mapRemove(channel, key);
          if (mode === "map_publish") return client.mapPublish(channel, key, data);
          return client.publish(channel, data);
        },
        {
          signal,
          prepare: async (check) => {
            channel = await evaluateSelector(RED, node, msg, selector, channelType, "channel");
            check();
            if (mapMode) {
              key = await evaluateSelector(RED, node, msg, keySelector, keyType, "key");
              check();
            }
            if (mode === "map_remove") {
              prepareRequest("publish", { channel, type: 1, key, removed: true }, server.maxMessageSize);
              return undefined;
            }
            if (mode === "map_publish")
              return prepareCommand("publish", { channel, type: 1, key }, msg.payload, server.maxMessageSize).data;
            return prepareCommand("publish", { channel }, msg.payload, server.maxMessageSize).data;
          },
        },
      );
      msg.centrifuge = mapMode ? { action: mode, channel, key } : { action: mode, channel };
    });
  }

  RED.nodes.registerType("centrifuge-out", CentrifugeOutNode);
};
