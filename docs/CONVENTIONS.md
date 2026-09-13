# Conventions

Read this for implementation, editor, documentation or package changes. [AGENTS.md](../AGENTS.md) holds the shared working agreement; [TESTING.md](TESTING.md) explains validation.

## Changing a node

Keep affected runtime, editor, help, examples and README behaviour consistent in the same change. A new node also needs a matching `package.json` registration, an example flow and runtime evidence. Small fixes only need changes to the surfaces they affect.

## Runtime

- Call `RED.nodes.createNode(this, config)` first. Receive `(msg, send, done)`, preserve incoming properties and settle each input exactly once with `done()` or `done(error)`.
- Validate imported configuration and message overrides at runtime. Preserve valid falsy payloads (`0`, `false`, `""`, `null`); a channel still requires a non-empty string.
- Follow the ownership boundaries in [ARCHITECTURE.md](ARCHITECTURE.md); test cancellation and partial redeploy when changing shared resources.
- Store secrets in Node-RED credentials. Use synthetic credentials only in isolated test fixtures; never put real credentials in defaults, diagnostics, example flows or committed files.

## Editor

- Keep runtime/editor type strings and the `node-red.nodes` package registration aligned. Persist normal properties in `defaults`, secrets in `credentials`; helper controls need not be persisted.
- Bind property controls with `node-input-<prop>` ids, or `node-config-input-<prop>` in the config node. Keep TypedInput value/type fields consistent on save and reopen.
- Never declare defaults named `status`, `id`, `type`, `z`, `wires`, `x`, `y`, `changed`, `valid` or `dirty`.
- Validators must work with and without an open dialog: read a live sibling control when present, otherwise use `this.<prop>`.
- Use documented Node-RED editor APIs. Theme custom dialog CSS through `--red-ui-*` variables; the node registration's `color` remains its palette colour. Preserve labelled controls and verify both themes for visual changes.
- Icons use Font Awesome 4 names or package assets under `nodes/icons/`, next to the registered node files. Keep hints short and explanations in help.
- Help uses `text/markdown` with Inputs, Outputs, Details and References as applicable to the node. Back behavioural claims with relevant execution evidence; prose-presence checks alone do not prove them.

## Style

Prettier and ESLint configurations own formatting and mechanical style. Use `async`/`await`; prefer `promisify`, event helpers and `Promise.withResolvers` over callback wrappers or promise chains. A necessary exception to the async checker needs a specific inline `allow-promise:` or `allow-timer:` reason. Preserve caught errors with `{ cause }` when wrapping them.

## Documentation and packaging

- Describe implemented behaviour in README/help; separate planned work from current coverage. Refer to package/fixture files for dependency pins instead of repeating patch versions or test counts in prose. Support floors, protocol versions and numeric public defaults remain useful documentation; dated evidence and changelogs may include exact versions.
- Keep user-visible changes under `[Unreleased]` in [CHANGELOG.md](../CHANGELOG.md), using Keep a Changelog categories and **Breaking** for explicitly intended breaking changes. Do not rewrite released history. Contributor-guidance edits alone do not need a product changelog entry.
- Keep root `AGENTS.md` under eighty lines; move subject-specific detail to its owning document. Use relative links and ordinary commands, without requiring a particular AI platform or local skill path. Keep tool-specific loader files as forwarding entries only.
- Dependency changes update both `package.json` and `package-lock.json` with exact pins. The package `files` allowlist must ship runtime/editor files, icons, libraries and examples while excluding test fixtures, internal guidance and caches.
- For packaging changes, run the package-contract check and the official-image install tests described in [TESTING.md](TESTING.md). `npm run check:release` checks publication metadata when release work is requested; it does not publish, and local development need not invent missing repository URLs to satisfy it.

## Evidence and handoff

- Pair a behavioural regression fix with a test that fails without the fix where practical. Avoid tests that merely reproduce implementation details.
- Report the changed behaviour, checks actually run and remaining gaps. Include a concise failure excerpt when a check fails; identify any substitute environment.
- Inspect screenshots before claiming visual quality. DOM assertions and generated screenshots alone establish no visual review.
- For a requested commit, retain the repository's `Co-Authored-By` convention for actual AI co-authors; do not invent identities. A PR description should explain the problem, resulting behaviour and relevant validation.
