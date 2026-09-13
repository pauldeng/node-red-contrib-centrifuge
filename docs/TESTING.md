# Test strategy

Goal: one real, cheap piece of evidence per behaviour, run where it is cheapest, with Docker only for the axes a
static binary cannot give. Tiers map to GitHub Actions jobs; every tier also runs locally with the same commands.

## Tiers

Docker tiers need a working `docker` CLI for the current user. `npm run docker:ensure` installs Docker on Ubuntu
22.04, 24.04 and 26.04 when it is missing (`scripts/ensure-docker-ubuntu.sh`) and otherwise checks the daemon is
reachable; a user newly added to the `docker` group needs a new login shell. `npm run test:docker:all` runs tiers
3 to 5 in order.

| Tier                          | Needs                                                                        | Runs                                      | Budget   | Command                    |
| ----------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------- | -------- | -------------------------- |
| 1 Unit                        | nothing                                                                      | every push, Node 24 + 26                  | < 10 s   | `npm run test:unit`        |
| 2 Runtime (binary)            | Centrifugo static binary (auto-downloaded), real Node-RED child              | every push, Node 24 + 26                  | < 60 s   | `npm run test:runtime`     |
| 3 Docker integration          | Docker: Centrifugo image (digest-pinned), TLS certs, fault injection         | every pull request, Node 24               | < 3 min  | `npm run test:docker`      |
| 4 Docker + Playwright UI      | Docker: Centrifugo; Chromium; local Node-RED child                           | every pull request, Node 24               | < 3 min  | `npm run test:ui`          |
| 5 Docker + browser end to end | Docker: Centrifugo + Node-RED image + a page running centrifuge-js; Chromium | pull requests after 3 and 4 pass; nightly | < 4 min  | `npm run test:e2e:browser` |
| Nightly                       | Docker; `centrifugo:v6` floating tag; long token-TTL runs                    | schedule only, never blocks a PR          | < 10 min | not yet implemented        |

Editor dialog tests (persistence, conditional rows, validators, overflow, icons) need no server and stay in the
existing Playwright suite (`npm run test:e2e`), run on every pull request without Docker.

## What belongs where

### Tier 1: pure logic, no I/O

- `lib/jwt.js` claim shape and signature; `lib/errors.js` code mapping and redaction; `lib/status.js` texts and
  renderer de-duplication; `lib/payload.js` JSON semantics, binary rejection, size bound, snapshot; `validate()` and
  `parseChannels()`; node runtimes against a fake `RED` and a stub server (deadline, cancellation, invalid config,
  status precedence); README and example contracts; package tarball contract.
- Rule: a unit test may never assert transport behaviour. Anything that depends on what Centrifugo or the SDK
  actually does on the wire moves to tier 2.

### Tier 2: real Node-RED + real Centrifugo binary (kept: fastest real-server evidence, ~100 ms per server start)

- All node contracts: subscribe/publish/receive, falsy payload matrix, permission denied, oversize preflight,
  server-side subscriptions, join/leave, missing server, modified-node and full redeploy, close with the server
  killed, examples round-trip, connection owner behaviour.
- Add (gaps found in review): static token expiry seen on a node as `disconnected: unauthorized (1)`; a
  `recover` namespace resubscribe after a server-initiated reconnect delivering the missed publications; anonymous
  mode on a node.

### Tier 3: Docker integration (axes the binary cannot provide cheaply)

- **TLS**: Centrifugo behind `wss://` with a self-signed certificate mounted into the container. Proves the
  `NODE_EXTRA_CA_CERTS` path on the Node-RED child, and that without the CA the node stays `connecting` with the
  transport error at debug level (the documented failure mode).
- **Network faults**: `docker pause` (stalled connection with no FIN) until the SDK's server-ping timeout moves the
  node to `connecting`; `docker unpause` and assert resubscribe; on a `force_recovery` namespace assert the
  publications made during the stall arrive. `docker network disconnect`/`connect` for the TCP-reset variant.
- **Reverse proxy**: nginx in front with the WebSocket upgrade. A second internal nginx listener checks the rewritten
  path and query before forwarding to Centrifugo; removing the query must fail the test. TLS is tested directly
  against Centrifugo in the separate TLS case.
- **Version pin**: `centrifugo/centrifugo:v6.9.4` by digest on pull requests; the floating `v6` tag only nightly.
- Node-RED stays a local child process in this tier; only Centrifugo and nginx run in containers.

### Tier 4: Docker + Playwright with a human looking at screenshots

- Live status badges on the canvas in both themes: `subscribed`, `connected`, `connecting` during a
  `docker pause`, red `disconnected: invalid token (3500)` with a wrong secret, red
  `unsubscribed: permission denied (103)` on a locked namespace.
- This tier uses a local Node-RED child. Official-image packaging and palette/dialog checks run in tier 5.

### Tier 5: Docker + browser end to end (the product's purpose)

- The official Node-RED image installs the packed tarball and verifies its node registrations, icon and dialog.
- A static page loads `centrifuge-js` from the package's own `node_modules` copy (no CDN) and connects to the
  containerised Centrifugo. Playwright drives the page.
- Browser subscribes, a flow publishes through `centrifuge out` (inject via the admin API), the page receives the
  data. The page publishes, `centrifuge in` receives it and the debug sidebar shows it. Join/leave from the browser
  appear on a node with `joinLeave` enabled.

### Nightly

- `centrifugo:v6` floating tag against the full tier 2 and 3 suites to catch upstream drift before users do.
- Connection-token refresh across a real expiry (`ttl` minimum is 60 s, so the run takes over a minute).

## CI layout

- `fast`: lint, format, `npm run check`, tiers 1 and 2, `npm pack --dry-run`; matrix Node 24 and 26; 15 min timeout.
- `editor`: dialog Playwright suite, Node 24, one worker; 20 min timeout.
- `docker`: tiers 3, 4 and 5 in one job with `--test-concurrency=1` and `max-parallel: 1`; images pulled by digest
  in a pre-step; Playwright browsers and the Centrifugo binary cached; 25 min timeout.
- Planned `nightly`: floating-version and long-refresh tests are not implemented yet. The current weekly schedule runs the existing CI jobs.

## Rules

- One real check per behaviour; no fake service that duplicates a real one.
- Waits are events: SDK and harness events, log lines through readline, Playwright expectations. No sleeps. A timer
  is only a deadline (`AbortSignal.timeout`) or a bounded negative assertion with an `allow-timer` comment.
- The one polling exception is a foreign process becoming ready (nothing emits "listening" to another process):
  wait for its own ready log line first, then confirm the socket, retrying only on `ECONNREFUSED` and yielding
  between attempts, bounded by the deadline. Both fixtures do exactly that.
- `async`/`await` only: no `new Promise`, no `.then` chains; `Promise.withResolvers` and the concurrency
  combinators are the allowed exceptions. `npm run check` enforces it for nodes, lib and test.
- Containers use unique names (per test, or a shared browser worker), stopped with `stop --time 5` then `rm -f -v`; Node-RED
  stops before the service it talks to.
- Start debug waiters before publish, browser subscription or page close; wait for the Node-RED subscription too.
- Startup failures clean partial containers/stacks and temporary configuration; cleanup failures fail the test.
- Mint short-lived expiry tokens only after the runtime has started.
- Report every tier as Passed, Failed, Not run or Substituted with its command.
