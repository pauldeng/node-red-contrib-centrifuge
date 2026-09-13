"use strict";
// Tier 3: reverse proxy. nginx terminates the WebSocket upgrade and forwards to Centrifugo over a private docker
// network; the client URL carries both a path prefix (/cf/) and a query parameter (?trace=1), proving both survive
// nginx's proxy_pass rewrite end to end.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { startNodeRed } = require("../../helpers/node-red");
const { startCentrifugoContainer, docker, hostPort, IMAGES } = require("../../helpers/docker");

const packageDir = path.resolve(__dirname, "../../..");

test("ws proxied through nginx: path prefix and query string preserved, subscribe and round-trip", async (t) => {
  const cleanups = [];
  t.after(async () => {
    const failures = [];
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Docker test cleanup failed");
  });

  const net = `nrc-net-${process.pid}`;
  await docker("network", "create", net);
  cleanups.push(() => docker("network", "rm", net));

  const srv = await startCentrifugoContainer({ network: net });
  cleanups.push(() => srv.stop());

  const dir = await mkdtemp(path.join(os.tmpdir(), "nrc-nginx-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const confPath = path.join(dir, "nginx.conf");
  await writeFile(
    confPath,
    `events {}
http {
  map $http_upgrade $connection_upgrade { default upgrade; "" close; }
  server {
    listen 8080;
    location /cf/ {
      proxy_pass http://127.0.0.1:8081/;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_set_header Host $host;
      proxy_read_timeout 300s;
    }
  }
  # Check what the rewriting proxy actually forwards; Centrifugo itself ignores the arbitrary trace parameter.
  server {
    listen 127.0.0.1:8081;
    location / { return 404; }
    location = /connection/websocket {
      if ($arg_trace != "1") { return 400; }
      proxy_pass http://${srv.name}:8000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
    }
  }
}
`,
  );

  const nginxName = `nrc-nginx-${process.pid}`;
  await docker(
    "create",
    "--name",
    nginxName,
    "--network",
    net,
    "-p",
    "127.0.0.1::8080",
    "-v",
    `${confPath}:/etc/nginx/nginx.conf:ro`,
    IMAGES.nginx,
  );
  cleanups.push(() => docker("rm", "-f", "-v", nginxName));
  await docker("start", nginxName);

  const nginxPort = await hostPort(nginxName, 8080);

  const nr = await startNodeRed({ packageDir });
  cleanups.push(() => nr.stop());

  const flow = [
    {
      id: "srv1",
      type: "centrifuge-server",
      name: "t",
      url: `ws://127.0.0.1:${nginxPort}/cf/connection/websocket?trace=1`,
      auth: "hmac",
      user: "node-red",
      channels: "",
      ttl: 3600,
      timeout: 1000,
      maxMessageSize: 65536,
      credentials: { secret: srv.secret },
    },
    {
      id: "in1",
      type: "centrifuge-in",
      z: "f1",
      server: "srv1",
      mode: "subscribe",
      channel: "news",
      joinLeave: false,
      subscriptionAuth: "none",
      wires: [["dbg1"]],
    },
    { id: "out1", type: "centrifuge-out", z: "f1", server: "srv1", channel: "news", channelType: "str", wires: [] },
    {
      id: "inj1",
      type: "inject",
      z: "f1",
      props: [{ p: "payload" }],
      payload: "viaProxy",
      payloadType: "str",
      wires: [["out1"]],
    },
    {
      id: "dbg1",
      type: "debug",
      z: "f1",
      active: true,
      tosidebar: true,
      complete: "true",
      targetType: "full",
      wires: [],
    },
    { id: "f1", type: "tab", label: "t" },
  ];

  const subscribed = nr.waitForStatus("in1", (s) => s.text === "subscribed", 5000);
  await nr.deploy(flow);
  await subscribed;

  const publication = nr.waitForDebug((d) => d.id === "dbg1" && d.msg?.centrifuge?.event === "publication");
  await nr.inject("inj1");
  const msg = (await publication).msg;
  assert.equal(msg.payload, "viaProxy");
  assert.equal(msg.centrifuge.channel, "news");
});
