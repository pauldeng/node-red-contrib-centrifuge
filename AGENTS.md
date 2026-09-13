# Agent guide — node-red-contrib-centrifuge

Node-RED >= 5 nodes for Centrifugo v6 over the `centrifuge` JavaScript client (WebSocket, JSON protocol). Design decisions and evidence live in `docs/TESTING.md`, the node help texts and the tests; reuse them, do not re-derive them. Follow user instructions and existing authorization. Local completion does not require a commit or release.

Runtime/editor type names, persisted fields, message shapes, status texts and error codes are public contracts. Preserve them unless the intended change requires a compatible extension or an explicit breaking change with a changelog entry.

## Commands

- `npm run fixture` — download and verify the pinned Centrifugo binary into `.cache/` (also runs as `pretest`)
- `npm run check` — package sanity, editor contract, and async-style gates
- `npm test` — checks, unit, package and real-runtime tests once (real Node-RED child + real Centrifugo)
- `npm run test:unit` / `npm run test:runtime` — focused tiers
- `npm run lint && npm run format:check`

## Contracts

- Node-RED >= 5 on Node.js >= 24; no Node-RED 4 or Node 22 compatibility code.
- The config node owns one SDK client and the subscription registry until it closes; consumers own their pending inputs. Close never awaits the network.
- Each input settles once; validation, dynamic evaluation, readiness and I/O share one error and deadline boundary. Catch exposes codes at `msg.error.code` from the closed set in `lib/errors.js`.
- Secrets live in Node-RED credentials; imported configuration and message overrides are validated at runtime.
- `async`/`await` only: no promise chains or `new Promise` in runtime or test code (`npm run check` enforces it; exceptions carry an inline `allow-promise:` or `allow-timer:` reason). This applies to `scripts/` too. Waits are events (`once`/`on`, log lines, harness waiters); a timer is only a deadline (`AbortSignal.timeout`) or a deliberately observed time window.
- Documented Node-RED APIs only; editor internals are not a contract. Exact dependency pins.
- Report checks as Passed, Failed, Not run or Substituted with the command; never claim a check that did not run.
