"use strict";
// Tier 5 (docs/TESTING.md): one compose stack (Centrifugo + the official Node-RED image, package installed from
// its own tarball) shared across every test in this project via worker-scoped fixtures, so the image build and
// `compose up` (both expensive) happen once per run. Fixed host ports 18800 (Centrifugo) / 18801 (Node-RED) are
// acceptable for this tier; a busy port fails fast with a clear message.
//
// Container readiness follows docker logs through readline; flow results use the admin comms websocket.
// Callers register debug waiters before the action and wait for the Node-RED subscription before publishing.
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { mkdtemp, rm, cp, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const http = require("node:http");
const { EventEmitter, on, once } = require("node:events");
const base = require("@playwright/test");
const { connectionToken } = require("../../../lib/jwt");
const { waitForLogLine } = require("../../helpers/docker");

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "../../..");
const COMPOSE_FILE = path.join(__dirname, "compose.yml");
const PROJECT = `nrc-e2e-${process.pid}`;
const CF_PORT = 18800;
const NR_PORT = 18801;
const NR_BASE = `http://127.0.0.1:${NR_PORT}`;
const CF_PUBLIC_WS = `ws://127.0.0.1:${CF_PORT}/connection/websocket`; // reached by the browser page

async function compose(...args) {
  const { stdout } = await run("docker", ["compose", "-p", PROJECT, "-f", COMPOSE_FILE, ...args], {
    cwd: __dirname,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  return stdout.trim();
}

let imageBuilt; // memoized in this worker process: the image build runs once per test run, not once per file
function ensureImage() {
  imageBuilt ??= (async () => {
    const { buildImage } = await import("./build-image.mjs");
    await buildImage();
  })();
  return imageBuilt;
}

async function startStack() {
  await ensureImage();
  try {
    await compose("up", "-d");
    const cfId = await compose("ps", "-q", "centrifugo");
    const nrId = await compose("ps", "-q", "nodered");
    await waitForLogLine(cfId, /serving .*endpoints on/, 30_000);
    await waitForLogLine(nrId, /Started flows/, 30_000);
  } catch (err) {
    // compose up can leave a partial stack when one service fails to start (including a busy host port).
    try {
      await stopStack();
    } catch (cleanup) {
      throw new AggregateError([err, cleanup], "stack startup and cleanup failed", { cause: cleanup });
    }
    const msg = String(err.stderr ?? err.message);
    if (/address already in use|port is already allocated/i.test(msg))
      throw new Error(`ports ${CF_PORT} (centrifugo) / ${NR_PORT} (node-red) must be free: ${msg}`, { cause: err });
    throw err;
  }
}

async function stopStack() {
  await compose("down", "-v", "--remove-orphans");
}

async function nrApi(method, route, body, headers = {}) {
  const res = await fetch(NR_BASE + route, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${await res.text()}`);
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
}

async function deploy(flows) {
  await nrApi("POST", "/flows", flows, { "Node-RED-Deployment-Type": "full" });
}

// The admin comms websocket, subscribed to "debug": lets a test await the exact debug message a flow produces
// (event-based) instead of polling the context API. Mirrors test/helpers/node-red.js's waitForDebug.
async function connectComms() {
  const ws = new WebSocket(`ws://127.0.0.1:${NR_PORT}/comms`);
  await once(ws, "open", { signal: AbortSignal.timeout(15_000) });
  const bus = new EventEmitter();
  ws.addEventListener("message", (ev) => {
    for (const { topic, data } of JSON.parse(ev.data)) bus.emit(topic, data);
  });
  ws.send(JSON.stringify({ subscribe: "debug" }));
  // A debug message's `msg` is JSON-encoded text when the payload is an object/array/error; decode it so callers
  // compare real values instead of strings (same convention as test/helpers/node-red.js's decode()).
  const decode = (d) =>
    /^(Object|array|error)/.test(d.format ?? "") && typeof d.msg === "string" ? { ...d, msg: JSON.parse(d.msg) } : d;
  const waitForDebug = async (predicate, timeoutMs = 15_000) => {
    const signal = AbortSignal.timeout(timeoutMs);
    for await (const [raw] of on(bus, "debug", { signal })) {
      const data = decode(raw);
      if (predicate(data)) return data;
    }
    throw new Error("comms closed before a matching debug message arrived");
  };
  const waitForStatus = async (id, predicate, timeoutMs = 15_000) => {
    const events = on(bus, `status/${id}`, { signal: AbortSignal.timeout(timeoutMs) });
    ws.send(JSON.stringify({ subscribe: `status/${id}` }));
    for await (const [status] of events) if (predicate(status)) return status;
    throw new Error("comms closed before the requested status arrived");
  };
  return { waitForDebug, waitForStatus, close: () => ws.close() };
}

// Tiny static file server for the browser page: copies centrifuge-js's own UMD bundle (no CDN) next to
// page/index.html into a temp dir and serves both on a free loopback port.
const MIME = { ".html": "text/html", ".js": "text/javascript" };
async function servePage() {
  const dir = await mkdtemp(path.join(tmpdir(), "nrc-e2e-page-"));
  await cp(path.join(__dirname, "page/index.html"), path.join(dir, "index.html"));
  await cp(path.join(ROOT, "node_modules/centrifuge/dist/centrifuge.js"), path.join(dir, "centrifuge.js"));
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = req.url.split("?")[0];
      const file = pathname === "/" ? "/index.html" : pathname;
      const data = await readFile(path.join(dir, file));
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    stop: async () => {
      server.close();
      await once(server, "close");
      await rm(dir, { recursive: true, force: true });
    },
  };
}

exports.test = base.test.extend({
  stack: [
    async ({}, use) => {
      await startStack();
      try {
        await use({ deploy, inject: (id) => nrApi("POST", `/inject/${id}`), comms: connectComms, wsUrl: CF_PUBLIC_WS });
      } finally {
        await stopStack();
      }
    },
    { scope: "worker" },
  ],
  pageServer: [
    async ({}, use) => {
      const server = await servePage();
      try {
        await use(server);
      } finally {
        await server.stop();
      }
    },
    { scope: "worker" },
  ],
  // Opens a browser page running centrifuge-js against the containerised Centrifugo, subscribed to `channel`.
  openClient: async ({ browser, stack, pageServer }, use) => {
    const opened = [];
    const open = async (channel, { sub = "browser" } = {}) => {
      const token = connectionToken({ secret: "test-secret", sub, ttl: 600 });
      const page = await browser.newPage();
      const qs = new URLSearchParams({ token, url: stack.wsUrl, channel });
      opened.push(page);
      await page.goto(`${pageServer.base}/?${qs}`);
      return page;
    };
    try {
      await use(open);
    } finally {
      await Promise.all(opened.map((p) => p.close()));
    }
  },
});
exports.expect = base.expect;
exports.NR_BASE = NR_BASE;
