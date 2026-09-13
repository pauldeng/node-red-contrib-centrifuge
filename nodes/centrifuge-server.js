"use strict";
// Config node: thin Node-RED glue around lib/connection.js. Owns one shared client until close; consumers register
// for status and use subscribe/onServerSide/run. Invalid configuration never connects; consumers see the status.
const { createConnection } = require("../lib/connection");
const { coded } = require("../lib/errors");
const { STATUS } = require("../lib/status");

module.exports = function (RED) {
  function CentrifugeServerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const users = new Map(); // consumer node id -> onStatus
    let closing = false;
    let conn = null;
    let failure = null;
    try {
      conn = createConnection({
        url: config.url,
        auth: config.auth,
        user: config.user,
        channels: config.channels,
        ttl: config.ttl,
        timeout: config.timeout,
        maxMessageSize: config.maxMessageSize,
        secret: node.credentials?.secret,
        token: node.credentials?.token,
        log: { debug: (m) => node.debug(m), warn: (m) => node.warn(m) },
      });
      conn.onStatus((status) => {
        for (const onStatus of users.values()) onStatus(status);
      });
    } catch (err) {
      failure = err; // consumers render "invalid config" and report it; inputs fail with INVALID_CONFIG
    }
    const current = () =>
      failure ? STATUS.invalidConfig(failure.message.replace(/^invalid configuration: /, "")) : conn.status();
    const guard = () => {
      if (closing) throw coded("CLOSING");
      if (failure) throw failure;
      if (conn.closing) throw coded("CLOSING");
    };

    node.register = (user, onStatus) => {
      users.set(user.id, onStatus);
      onStatus(current());
      conn?.connect(); // the first consumer starts the connection; it lives until this node closes
    };
    node.deregister = (user) => {
      users.delete(user.id);
    };
    node.subscribe = (channel, consumer, opts) => {
      guard();
      return conn.subscribe(channel, consumer, opts);
    };
    node.onServerSide = (consumer) => {
      guard();
      return conn.onServerSide(consumer);
    };
    node.run = async (work, opts) => {
      guard();
      return conn.run(work, opts);
    };
    node.timeout = conn?.timeout ?? null;
    node.maxMessageSize = conn?.maxMessageSize ?? null;
    Object.defineProperty(node, "closing", { get: () => closing });

    node.on("close", (_removed, done) => {
      closing = true;
      conn?.close(); // synchronous: disconnect, then drop subscriptions; nothing awaits the network
      users.clear();
      done();
    });
  }

  RED.nodes.registerType("centrifuge-server", CentrifugeServerNode, {
    credentials: { token: { type: "password" }, secret: { type: "password" } },
  });
};
