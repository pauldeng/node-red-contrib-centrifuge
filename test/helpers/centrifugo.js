"use strict";
// Real Centrifugo v6 fixture: spawns the pinned static binary (see scripts/fixture-centrifugo.mjs) on a free
// loopback port with a test config, waits for /health, and stops it with a bounded SIGTERM/SIGKILL.
// Default namespace allows everything a client may do; "locked" allows nothing; "recover" forces recovery.
const { spawn } = require("node:child_process");
const { EventEmitter, on, once } = require("node:events");
const { access, mkdtemp, rm, writeFile } = require("node:fs/promises");
const { setImmediate: yieldLoop } = require("node:timers/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const VERSION = "6.9.4";
const DEFAULT_BIN = path.resolve(__dirname, "../../.cache/centrifugo", VERSION, "centrifugo");
const SECRET = "test-secret";
const API_KEY = "test-api-key";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {}))
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? merge(base[k], v) : v;
  return out;
}

async function freePort() {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const { port } = srv.address();
  srv.close();
  await once(srv, "close");
  return port; // small race with other processes; callers retry via startCentrifugo's exit check
}

// The process logs "serving ..." a few milliseconds before bind() completes, so one connect may still be refused.
// Retry only on ECONNREFUSED, yielding to the event loop between attempts (no sleep constant); the signal bounds it.
async function waitForPort(port, signal) {
  for (;;) {
    const socket = net.connect({ port, host: "127.0.0.1" });
    try {
      await once(socket, "connect", { signal });
      return;
    } catch (err) {
      if (err.code !== "ECONNREFUSED") throw err;
      await yieldLoop(undefined, { signal });
    } finally {
      socket.destroy();
    }
  }
}

function baseConfig(port) {
  return {
    http_server: { address: "127.0.0.1", port },
    log: { level: "info" },
    health: { enabled: true },
    http_api: { key: API_KEY },
    client: { token: { hmac_secret_key: SECRET }, allowed_origins: ["*"] },
    channel: {
      without_namespace: {
        allow_subscribe_for_client: true,
        allow_publish_for_client: true,
        allow_history_for_client: true,
        allow_presence_for_client: true,
        presence: true,
        join_leave: true,
        force_push_join_leave: true,
        history_size: 10,
        history_ttl: "60s",
      },
      namespaces: [
        { name: "locked" },
        {
          name: "recover",
          allow_subscribe_for_client: true,
          allow_publish_for_client: true,
          history_size: 10,
          history_ttl: "60s",
          force_recovery: true,
        },
      ],
    },
  };
}

async function startCentrifugo({
  bin = process.env.CENTRIFUGO_BIN || DEFAULT_BIN,
  config = {},
  timeoutMs = 15_000,
  log = false,
} = {}) {
  try {
    await access(bin);
  } catch {
    throw new Error(`Centrifugo binary not found at ${bin}; run: node scripts/fixture-centrifugo.mjs`);
  }
  const port = await freePort();
  const dir = await mkdtemp(path.join(os.tmpdir(), "centrifugo-test-"));
  const cfg = merge(baseConfig(port), config);
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(cfg));
  const child = spawn(bin, ["--config", configPath], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  const bus = new EventEmitter(); // "line" events: readiness waits on the server log, no polling
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of chunk.split("\n"))
        if (line) {
          lines.push(line);
          if (log) console.log("[centrifugo]", line);
          bus.emit("line", line);
        }
    });
  }
  let stopped = null;
  const stop = async () => {
    stopped ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
        child.kill("SIGTERM");
        try {
          await exited;
        } catch (err) {
          if (err.name !== "AbortError") throw err;
          const killed = once(child, "exit");
          child.kill("SIGKILL");
          await killed;
        }
      }
      await rm(dir, { recursive: true, force: true });
    })();
    return stopped;
  };
  const base = `http://127.0.0.1:${port}`;
  // Ready when Centrifugo logs that it is listening ("serving websocket, api, health endpoints on ...").
  // The deadline is an AbortSignal; a premature exit rejects first.
  const READY = /serving .*endpoints on/;
  const signal = AbortSignal.timeout(timeoutMs);
  const exited = (async () => {
    const [code] = await once(child, "exit", { signal });
    throw new Error(`centrifugo exited with ${code} before ready; last logs:\n${lines.slice(-10).join("\n")}`);
  })();
  const listening = (async () => {
    if (lines.some((l) => READY.test(l))) return;
    for await (const [line] of on(bus, "line", { signal })) if (READY.test(line)) return;
  })();
  try {
    await Promise.race([listening, exited]);
    await waitForPort(port, signal);
  } catch (err) {
    await stop();
    if (err.name === "AbortError" || err.name === "TimeoutError")
      throw new Error(
        `centrifugo not ready on ${port} within ${timeoutMs} ms; last logs:\n${lines.slice(-10).join("\n")}`,
        { cause: err },
      );
    throw err;
  }
  const api = async (method, params) => {
    const res = await fetch(`${base}/api/${method}`, {
      method: "POST",
      headers: { "X-API-Key": API_KEY, "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`server API ${method} failed: HTTP ${res.status}`);
    return res.json();
  };
  return {
    port,
    url: `ws://127.0.0.1:${port}/connection/websocket`,
    httpUrl: base,
    secret: SECRET,
    apiKey: API_KEY,
    lines,
    child,
    config: cfg,
    api, // e.g. api("publish", { channel, data }) or api("disconnect", { user })
    stop,
  };
}

module.exports = { startCentrifugo, baseConfig, merge, VERSION, SECRET, API_KEY };
