"use strict";
// Minimal Centrifugo RPC proxy backend for tests (https://centrifugal.dev/docs/server/proxy):
// Centrifugo POSTs {client, user, method, data, ...} as JSON; the backend answers {result: {data}} or
// {error: {code, message}}. Methods: "echo" returns {method, data, user}; "fail" returns error 1001; "hold" waits for release(); others 1002.
const http = require("node:http");
const { EventEmitter, once } = require("node:events");

async function startRpcBackend() {
  const requests = [];
  const events = new EventEmitter();
  const held = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      body = {};
    }
    requests.push({ url: req.url, headers: req.headers, body });
    const reply = (obj) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (body.method === "hold") {
      held.push(() => reply({ result: { data: body.data } }));
      events.emit("held");
    } else if (body.method === "echo")
      reply({ result: { data: { method: body.method, data: body.data ?? null, user: body.user } } });
    else if (body.method === "fail") reply({ error: { code: 1001, message: "backend refused" } });
    else reply({ error: { code: 1002, message: "unknown method" } });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    port,
    endpoint: `http://127.0.0.1:${port}/rpc`,
    requests,
    events,
    release: () => {
      for (const reply of held.splice(0)) reply();
    },
    // Centrifugo config fragment enabling the RPC proxy for the default rpc namespace.
    config: {
      rpc: {
        proxy: { endpoint: `http://127.0.0.1:${port}/rpc`, timeout: "5s" },
        without_namespace: { proxy_enabled: true },
      },
    },
    stop: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

module.exports = { startRpcBackend };
