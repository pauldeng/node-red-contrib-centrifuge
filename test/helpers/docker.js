"use strict";
// Docker-backed Centrifugo for the Docker tiers (docs/TESTING.md tiers 3-5): digest-pinned image, config file
// bind-mounted, optional self-signed TLS, host port published on loopback only, fault injection with pause/unpause.
// Node-RED stays a local child (test/helpers/node-red.js) unless a tier explicitly runs the official image.
// A missing or unreachable Docker daemon is a hard failure with the fix named, never a silent skip.
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { mkdtemp, writeFile, readFile, rm, chmod } = require("node:fs/promises");
const https = require("node:https");
const http = require("node:http");
const { EventEmitter, on, once } = require("node:events");
const { createInterface } = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const { baseConfig, merge, SECRET, API_KEY } = require("./centrifugo");

const run = promisify(execFile);
// Pinned by tag and digest (docker image inspect on 2026-09-13).
const IMAGES = Object.freeze({
  centrifugo: "centrifugo/centrifugo:v6.9.4@sha256:78b2fcd11e69f7cd82072924db99865be2beba4a03087d8ce0f5008ae357abe4",
  nginx: "nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236",
  nodered: "nodered/node-red:5.0.7",
});

async function docker(...args) {
  const { stdout } = await run("docker", args, { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
  return stdout.trim();
}

async function requireDocker() {
  try {
    await docker("info");
  } catch {
    throw new Error(
      "Docker is required for this tier: run `npm run docker:ensure` (installs on Ubuntu), start the daemon, " +
        "or add your user to the docker group and open a new shell",
    );
  }
}

// Published host port for a container port, e.g. 8000/tcp -> 32769 (loopback only).
async function hostPort(name, containerPort = 8000) {
  const out = await docker("port", name, `${containerPort}/tcp`);
  const m = out.match(/:(\d+)\s*$/m);
  if (!m) throw new Error(`no published port for ${name}:${containerPort}; docker port said: ${out}`);
  return Number(m[1]);
}

// CA + server certificate for localhost/127.0.0.1 with a two-day lifetime. openssl ships on Ubuntu runners.
async function selfSignedTls(dir) {
  const f = (n) => path.join(dir, n);
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    f("ca.key"),
    "-out",
    f("ca.pem"),
    "-days",
    "2",
    "-subj",
    "/CN=node-red-contrib-centrifuge test CA",
  ]);
  await run("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    f("server.key"),
    "-out",
    f("server.csr"),
    "-subj",
    "/CN=localhost",
  ]);
  await writeFile(f("ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
  await run("openssl", [
    "x509",
    "-req",
    "-in",
    f("server.csr"),
    "-CA",
    f("ca.pem"),
    "-CAkey",
    f("ca.key"),
    "-CAcreateserial",
    "-out",
    f("server.pem"),
    "-days",
    "2",
    "-extfile",
    f("ext.cnf"),
  ]);
  return {
    caFile: f("ca.pem"),
    ca: await readFile(f("ca.pem"), "utf8"),
    cert: await readFile(f("server.pem"), "utf8"),
    key: await readFile(f("server.key"), "utf8"),
  };
}

// One HTTP(S) GET with an optional private CA; returns the status code or throws.
async function probe(url, { ca } = {}) {
  const mod = url.startsWith("https") ? https : http;
  const req = mod.get(url, { ca, servername: "localhost", signal: AbortSignal.timeout(1_500) });
  req.on("error", () => {}); // once handles pre-response errors; destruction below may emit a late request error
  const [res] = await once(req, "response");
  res.destroy();
  return res.statusCode;
}

// Event-based readiness: follow the container log (history is replayed, so there is no race) until a line matches.
async function waitForLogLine(name, re, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const follow = spawn("docker", ["logs", "-f", name], { stdio: ["ignore", "pipe", "pipe"] });
  const bus = new EventEmitter();
  follow.on("error", (err) => bus.emit("error", err));
  follow.on("close", (code) => bus.emit("error", new Error(`docker logs ended before readiness (exit ${code})`)));
  for (const stream of [follow.stdout, follow.stderr])
    createInterface({ input: stream }).on("line", (l) => bus.emit("line", l));
  try {
    for await (const [line] of on(bus, "line", { signal })) if (re.test(line)) return line;
  } finally {
    // Keep the bus safe while the killed child closes; the async iterator has removed its error listener.
    bus.on("error", () => {});
    if (follow.exitCode === null && follow.signalCode === null) {
      const closed = once(follow, "close", { signal: AbortSignal.timeout(5_000) });
      follow.kill();
      await closed;
    }
  }
  throw new Error("log follow ended before the ready line");
}

// startCentrifugoContainer({ config, tls, name, network }) -> { name, port, url, httpUrl, ca, caFile, secret, apiKey,
//   api(method, params), pause(), unpause(), logs(), stop() }. Same default namespaces as the binary fixture.
async function startCentrifugoContainer({ config = {}, tls = false, name, network, timeoutMs = 30_000 } = {}) {
  await requireDocker();
  name ??= `nrc-centrifugo-${process.pid}-${Date.now().toString(36)}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), `nrc-docker-${process.pid}-`));
  let stopped = null;
  let created = false;
  const stop = async () => {
    stopped ??= (async () => {
      if (created) {
        try {
          await docker("stop", "--time", "5", name);
        } catch {
          /* paused or already stopped; rm is authoritative */
        }
        try {
          await docker("rm", "-f", "-v", name);
        } catch (err) {
          if (!/No such container/i.test(String(err.stderr ?? err.message))) throw err;
        }
      }
      await rm(dir, { recursive: true, force: true });
    })();
    return stopped;
  };
  try {
    const cfg = merge(baseConfig(8000), config);
    cfg.http_server.address = "0.0.0.0"; // inside the container; the host mapping is loopback only
    let tlsInfo = null;
    if (tls) {
      tlsInfo = await selfSignedTls(dir);
      cfg.http_server.tls = { enabled: true, cert_pem: tlsInfo.cert, key_pem: tlsInfo.key };
    }
    await writeFile(path.join(dir, "config.json"), JSON.stringify(cfg));
    await chmod(path.join(dir, "config.json"), 0o644);
    await docker(
      "create",
      "--name",
      name,
      ...(network ? ["--network", network] : []),
      "-p",
      "127.0.0.1::8000",
      "-v",
      `${path.join(dir, "config.json")}:/centrifugo/config.json:ro`,
      IMAGES.centrifugo,
      "centrifugo",
      "--config",
      "/centrifugo/config.json",
    );
    created = true;
    await docker("start", name);
    const scheme = tls ? "https" : "http";
    // Readiness = the server's own "serving" line, a published host port and a 200 from /health. Centrifugo logs
    // "serving" before bind(), so a process that dies on bind (bad port, busy address) is caught by the last two steps.
    let port;
    let httpUrl;
    try {
      await waitForLogLine(name, /serving .*endpoints on/, timeoutMs);
      port = await hostPort(name);
      httpUrl = `${scheme}://127.0.0.1:${port}`;
      const status = await probe(`${httpUrl}/health`, { ca: tlsInfo?.ca });
      if (status !== 200) throw new Error(`/health answered HTTP ${status}`);
    } catch (err) {
      let logs = "";
      try {
        logs = await docker("logs", "--tail", "20", name);
      } catch {
        // container already gone
      }
      throw new Error(
        `centrifugo container ${name} not ready within ${timeoutMs} ms (${err.message}); logs:\n${logs}`,
        {
          cause: err,
        },
      );
    }
    const api = async (method, params) => {
      const body = JSON.stringify(params);
      const mod = tls ? https : http;
      const req = mod.request(`${httpUrl}/api/${method}`, {
        method: "POST",
        headers: {
          "X-API-Key": API_KEY,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        ca: tlsInfo?.ca,
        servername: "localhost",
        signal: AbortSignal.timeout(5_000),
      });
      req.on("error", () => {}); // after headers, errors reject the response iterator instead
      req.end(body);
      const [res] = await once(req, "response");
      const chunks = [];
      for await (const c of res) chunks.push(c);
      if (res.statusCode !== 200) throw new Error(`server API ${method} failed: HTTP ${res.statusCode}`);
      return JSON.parse(Buffer.concat(chunks).toString());
    };
    return {
      name,
      port,
      url: `${tls ? "wss" : "ws"}://127.0.0.1:${port}/connection/websocket`,
      httpUrl,
      ca: tlsInfo?.ca,
      caFile: tlsInfo?.caFile,
      secret: SECRET,
      apiKey: API_KEY,
      config: cfg,
      api,
      pause: () => docker("pause", name), // frozen process: TCP stays open, nothing answers (stall)
      unpause: () => docker("unpause", name),
      logs: () => docker("logs", name),
      stop,
    };
  } catch (err) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError([err, cleanup], "container startup and cleanup failed", { cause: cleanup });
    }
    throw err;
  }
}

module.exports = {
  IMAGES,
  docker,
  requireDocker,
  hostPort,
  selfSignedTls,
  probe,
  waitForLogLine,
  startCentrifugoContainer,
};
