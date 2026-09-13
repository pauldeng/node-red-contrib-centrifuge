"use strict";
// Runtime for `centrifuge in`: no input, one output. Subscribes (client-side) or filters the server node's
// server-side subscriptions, turning each publication/join/leave into one outgoing msg. No timers, no promises.
const { coded, fromSdkError } = require("../lib/errors");
const { STATUS, statusRenderer } = require("../lib/status");

module.exports = function (RED) {
  function CentrifugeInNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const render = statusRenderer(node);
    const server = RED.nodes.getNode(config.server);
    let closing = false;
    let dispose = null;

    const onEvent = (ctx) => {
      if (closing) return;
      const msg = {
        topic: ctx.channel,
        payload: ctx.event === "publication" ? ctx.data : ctx.info,
        centrifuge: {
          event: ctx.event,
          channel: ctx.channel,
          ...(ctx.offset !== undefined && { offset: ctx.offset }),
          ...(ctx.tags !== undefined && { tags: ctx.tags }),
          ...(ctx.info !== undefined && { info: ctx.info }),
        },
      };
      // The connection fans the same ctx out to every consumer of a channel: never share ctx.data by reference.
      node.send(RED.util.cloneMessage(msg));
    };

    if (!server) {
      render(STATUS.missingServer);
    } else {
      try {
        const mode = config.mode === undefined ? "subscribe" : config.mode;
        if (!["subscribe", "server"].includes(mode)) throw coded("INVALID_CONFIG", "mode must be subscribe or server");
        if (config.joinLeave !== undefined && typeof config.joinLeave !== "boolean")
          throw coded("INVALID_CONFIG", "joinLeave must be a boolean");
        // Subscription registrations seed and combine their own status; a raw connection event must not
        // overwrite a subscription failure or briefly render a refused subscription green.
        if ((config.mode ?? "subscribe") === "server") {
          dispose = server.onServerSide({
            channel: config.channel === "" ? undefined : config.channel,
            joinLeave: config.joinLeave === true,
            onEvent,
            onStatus: render,
          });
        } else {
          dispose = server.subscribe(
            config.channel,
            { onEvent, onStatus: render },
            {
              joinLeave: config.joinLeave === true,
              subscriptionAuth: config.subscriptionAuth === undefined ? "none" : config.subscriptionAuth,
            },
          );
        }
        server.register(node, () => {});
      } catch (err) {
        if (err.code === "INVALID_CONFIG") {
          // strip the shared "invalid configuration: " prefix so the status text does not double it (see
          // nodes/centrifuge-server.js's `current()`, which applies the same fix for the same reason).
          render(STATUS.invalidConfig(err.message.replace(/^invalid configuration: /, "")));
        } else if (err.code === "CONFIG_CONFLICT") {
          render(
            Object.freeze({
              fill: "red",
              shape: "ring",
              text: "conflict: channel is server-side",
              terminal: true,
            }),
          );
        } else render(STATUS.invalidConfig(fromSdkError(err).message));
      }
    }

    node.on("close", (_removed, done) => {
      closing = true;
      dispose?.();
      server?.deregister(node);
      node.status({});
      done();
    });
  }
  RED.nodes.registerType("centrifuge-in", CentrifugeInNode);
};
