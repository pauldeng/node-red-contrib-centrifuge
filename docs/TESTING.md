# Testing

Read this for local setup, test selection, fixtures and CI. Run commands from the repository root. [package.json](../package.json) defines the scripts; [.github/workflows/ci.yml](../.github/workflows/ci.yml) defines the current CI matrix and triggers.

## Setup

Use Node.js 24+ and npm, then install the locked dependencies:

```sh
npm ci
```

There is no build step. The runtime suites start isolated Node-RED children with temporary user directories and deploy flows through the admin API; you do not need a running personal Node-RED instance.

- **Binary runtime tests:** `npm test` runs `npm run fixture` through its pretest hook. Direct `npm run test:runtime` and single-file commands do not: run `npm run fixture` first on a fresh checkout. The download needs GitHub access and `tar`, then caches the pinned binary under `.cache/centrifugo/`. The downloader and helpers currently assume Unix-style extraction/executables; use Linux or WSL for the CI-equivalent workflow rather than assuming native Windows support.
- **Browser tests:** run `npx playwright install chromium` once. On a Linux host missing browser system libraries, `npx playwright install --with-deps chromium` also installs OS packages and may require administrator privileges. Tests use the installed Playwright version and a single worker.
- **Docker tiers:** require `docker info` to succeed for the current user, Docker Compose v2 (`docker compose version`) for the browser stack, and `openssl` for TLS fixture certificates. Initial image pulls and the official-image build require network access. Allow local loopback listeners and child processes.
- **Browser stack isolation:** tier 5 currently binds host ports `18800` and `18801` and builds the shared image tag `nrc-nodered-e2e:local`. Keep those ports free and run only one tier-5 suite per Docker daemon at a time, including across checkouts.
- **Optional Ubuntu provisioning:** `npm run docker:ensure` can install Docker and change system packages, services and group membership. It is a host-provisioning command, not a routine test prerequisite. On an existing installation, fix daemon access using the host's normal setup; a newly granted Docker group membership needs a fresh login session. Do not assume another developer's group or shell workaround applies.

For a manual editor smoke check, install this checkout into a disposable Node-RED user directory and import an example as described in [README.md](../README.md). Do not deploy test flows into a personal running instance.

## Choose checks by change

| Change                                          | Validation                                                                                                                                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contributor docs only                           | Check relative links and named commands; `node --test test/unit/docs.test.js`; `npm run format:check`.                                                                                                    |
| Runtime logic, node behaviour or lifecycle      | Focused unit/runtime test first, then `npm test`, `npm run lint` and `npm run format:check`.                                                                                                              |
| Editor fields, validation, help or layout       | Relevant editor spec with `npm run test:e2e -- test/e2e/server.spec.js` (replace the filename), plus static gates and affected runtime tests. Use the full editor suite when shared UI behaviour changes. |
| Transport, TLS, proxy, expiry or Docker fixture | Relevant `test/docker/integration/*.test.js`; shared fixture changes need `npm run test:docker:all`.                                                                                                      |
| Live status rendering                           | `npm run test:ui`, plus status/unit tests; inspect screenshots for visual claims.                                                                                                                         |
| Package allowlist, registration or dependencies | `node --test test/package-contract.test.js`, `npm pack --dry-run`, `npm run test:e2e:browser` for a clean tarball install in the official Node-RED image, plus tests affected by the dependency change.   |

`npm run check` covers package sanity, editor-contract heuristics and async-style checks. It is part of `npm test`; it does not run lint or browser tests. `npm run format` rewrites the whole repository, so prefer `npx prettier --write <changed-files>` for a scoped edit.

Focused examples (replace the test file as needed):

```sh
node --test test/unit/payload.test.js
npm run fixture
node --test --test-concurrency=1 test/runtime/centrifuge-out.test.js
node --test --test-concurrency=1 test/runtime/centrifuge-request.test.js
npm run test:e2e -- test/e2e/request.spec.js
node --test --test-concurrency=1 test/docker/integration/proxy.test.js
```

## Current suites

| Suite                       | Environment and coverage                                                                                                                                                                       | Command                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Unit                        | Pure helpers, fake-RED node tests, deadlines/cancellation, validation, errors/status, JSON payload semantics, README/example contracts. No real transport assertions.                          | `npm run test:unit`                         |
| Package contract            | Tarball contents and registration checks; separate from the unit-only command.                                                                                                                 | `node --test test/package-contract.test.js` |
| Runtime (tier 2)            | Real Node-RED child and Centrifugo binary: publish/subscribe, payloads, permissions, preflight, server-side subscriptions, join/leave, auth, examples and redeploy.                            | `npm run test:runtime`                      |
| Editor                      | Local Node-RED and Chromium; dialogs, persistence, conditional controls, validators, layout and icons. No Centrifugo or Docker needed.                                                         | `npm run test:e2e`                          |
| Docker integration (tier 3) | Local Node-RED; containerised Centrifugo/nginx: TLS CA trust, stalled connection deadlines/reconnect, real static-token expiry, proxy path/query handling and fixture cleanup.                 | `npm run test:docker`                       |
| Docker UI (tier 4)          | Local Node-RED, containerised Centrifugo and Chromium: live/terminal canvas status in both themes and rejection of anonymous auth.                                                             | `npm run test:ui`                           |
| Docker browser (tier 5)     | Official Node-RED image installing this package's tarball, Centrifugo and a Chromium page using the installed SDK: registrations/icons/dialog, publications in both directions and join/leave. | `npm run test:e2e:browser`                  |

`npm test` runs the static gates, unit, package-contract and binary runtime suites. `npm run test:docker:all` runs tiers 3–5 sequentially; it does not include the separate editor suite.

The browser page loads the SDK from this checkout's dependencies rather than a CDN. Server/image pins live in [scripts/fixture-centrifugo.mjs](../scripts/fixture-centrifugo.mjs), the [binary helper](../test/helpers/centrifugo.js), [Docker helper](../test/helpers/docker.js), [Compose file](../test/docker/browser/compose.yml), [Dockerfile](../test/docker/browser/Dockerfile) and CI. Keep references aligned when intentionally updating a pin; recheck relevant SDK assumptions in [ARCHITECTURE.md](ARCHITECTURE.md).

## Fixture and assertion rules

- Reuse [test/helpers/node-red.js](../test/helpers/node-red.js) for real Node-RED and the matching binary/Docker helper for Centrifugo. A unit stub must not be used as evidence for SDK or wire behaviour.
- [test/helpers/rpc-backend.js](../test/helpers/rpc-backend.js) starts a minimal `node:http` server implementing Centrifugo's HTTP RPC proxy protocol for `centrifuge-request` RPC tests: method `echo` succeeds, `fail` answers error 1001, `hold` waits for the test to call `release()`, and anything else answers error 1002. Its `config` fragment enables the proxy when passed to `startCentrifugo`.
- Give regular flow nodes unique ids distinct from type names (for example `catch1`) and a `z` pointing to a tab. Config nodes and tabs do not need `z`.
- Wait for events, log lines, harness waiters or Playwright expectations. Register debug waiters before triggering publish, subscription or page close, and wait for the receiving subscription before publishing.
- Use one bounded deadline for each wait; no arbitrary sleeps. A deliberately observed negative window needs an inline `allow-timer:` reason. The binary helper waits for the server's ready log and retries only a refused socket connection until its deadline; the Docker helper checks the ready log, mapped port and HTTP health response.
- Use `async`/`await`, event helpers, `Promise.withResolvers` and concurrency combinators. `npm run check` enforces promise-chain/constructor and test-timer restrictions in `nodes/`, `lib/`, `test/` and `scripts/`; justified exceptions carry an inline checker reason.
- Keep `pong_timeout` below `ping_interval` in Centrifugo test config. Mint short-lived expiry tokens only after Node-RED has started.
- A stall test must issue the publish while the SDK still considers the paused connection connected to prove an acknowledgement timeout. After recovery, distinguish a new publication from a timed-out command that may arrive late.
- The proxy fixture validates the rewritten path and query at a second nginx listener. Dropping query parameters must fail the test; a successful WebSocket connection alone proves no query preservation.
- Register cleanup as each resource is acquired. Startup failure must remove partial resources, preserve an existing container on name collision and report cleanup failures. Stop Node-RED before its server; unpause a paused container before shutdown.
- Use unique container/stack names. Docker fixtures stop with a bounded grace period and remove containers/volumes. Do not clean unrelated containers, networks or a developer's Node-RED data.

## CI and artifacts

All current jobs run on pull requests, pushes to `main` and a weekly schedule:

- `fast`: Node.js 24 and 26; lint, format, `npm test`, production dependency audit and pack dry run.
- `heavy` (displayed as editor dialogs): Node.js 24; the standalone editor Playwright suite.
- `docker`: Node.js 24; integration, UI and browser tiers run sequentially in one job.

Job timeouts are defined in the workflow; a first run includes downloads and builds, so they are not local performance guarantees. The weekly schedule runs these same jobs, not a separate floating-version/nightly suite.

Playwright retains failure traces under `test-results/`; selected specs also save screenshots under `test-results/screenshots/`. CI uploads these on failure. Inspect an available trace with `npx playwright show-trace <trace.zip>`. Inspect screenshots before reporting visual quality; DOM assertions only prove the asserted DOM state.

## Known coverage gaps

These are follow-up opportunities, not prerequisites for unrelated changes or claims of existing coverage:

- Missed-publication recovery after reconnect; the existing stall test proves resubscription and a new publication, not replay.
- Docker network disconnect/connect as a separate TCP-reset fault.
- Successful anonymous auth through a deployed node (connection-level auth coverage exists).
- Automatic HMAC refresh across real expiry; the existing expiry test covers a static token becoming terminal.
- Floating server-version and long-running scheduled compatibility tests.
