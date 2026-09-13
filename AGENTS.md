# @pauldeng/node-red-contrib-centrifuge

Node-RED nodes for subscribing to and publishing on Centrifugo channels through the official `centrifuge` JavaScript client (WebSocket, JSON), connecting flows with browsers and backends.

This is the shared repository guide for any coding agent. Read linked documents when their subject is relevant; no particular AI platform, external skill, or developer's local setup is required.

## Start here

- Use Node.js 24+ and npm. Run `npm ci` from the repository root. There is no build or transpilation step; runtime code is CommonJS, utility scripts may be ES modules.
- [README.md](README.md) and each `nodes/*.html` help block describe the public node contract, installation, examples and troubleshooting.
- For runtime or ownership changes, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- For runtime/editor conventions, documentation or packaging changes, read [docs/CONVENTIONS.md](docs/CONVENTIONS.md).
- For setup, test selection, fixtures or CI changes, read [docs/TESTING.md](docs/TESTING.md).
- For versioning and publishing, read [docs/RELEASE.md](docs/RELEASE.md); publishing is a maintainer action, never automated from a session.
- [package.json](package.json) and its lockfile define scripts, supported versions and exact dependency pins. Verify documentation against the owning code/tests when they disagree; report the discrepancy and correct it within the task's scope.

## Verify the change

- `npm test` runs static gates, unit, package and real-runtime tests. Its pretest downloads the pinned Centrifugo binary into `.cache/` when absent; no Docker needed.
- `npm run check` runs package, editor-contract and async-style gates only; it does not prove runtime behaviour.
- `npm run lint` and `npm run format:check` are the lint and formatting gates. Format affected files rather than reformatting unrelated work.
- Editor changes also need `npm run test:e2e`; transport, container and browser interoperability changes use the relevant Docker tiers. Prerequisites and focused commands are in [docs/TESTING.md](docs/TESTING.md).
- Finish by reviewing the diff, synchronising affected help/examples/docs, and reporting checks as Passed, Failed, Not run or Substituted with their commands and any remaining limitations. Documentation-only edits need link/command checks and formatting, not the network suites.

## Repository constraints

- Preserve registered type names, saved fields, message shapes, status texts and error codes unless the requested change requires an extension or explicitly permits a breaking change. Record user-visible changes in `CHANGELOG.md`; an entry alone does not authorize a breaking change.
- Target Node-RED 5+ on Node.js 24+; do not add compatibility code for older versions. Use documented Node-RED APIs and exact dependency pins.
- Use `async`/`await`, not promise chains or `new Promise`. Use event-driven waits; justified exceptions need the checker's inline `allow-promise:` or `allow-timer:` reason. See the conventions and testing guides for details.
- Keep secrets in Node-RED credentials and validate imported configuration and message inputs at runtime.
- Preserve unrelated working-tree changes. Follow the user's instructions and existing authorization; do not commit, push, tag or publish unless asked. Local completion does not require a commit or release.
- Keep durable guidance here or in its owning document, using repository-relative links. Tool-specific entry files should only forward to this guide. Replace stale instructions instead of accumulating exceptions or session history.
