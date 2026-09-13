# Changelog

All notable changes to this project are documented here. Format: Keep a Changelog. Versioning: semver; breaking changes are called out under **Breaking**.

## [Unreleased]

### Added

- `centrifuge-server` config node: HMAC, static token, and anonymous auth modes, one shared connection per configuration, and a message-size preflight setting.
- `centrifuge-in` node: client-side subscribe and server-side subscription modes, join/leave events, and per-channel subscription tokens.
- `centrifuge-out` node: publish with a TypedInput channel selector, `JSON.stringify`-compatible payload rules, and an acknowledgement output.
- Test harness running real Node-RED and a real Centrifugo binary downloaded once into a local fixture.
- Centrifugal logo mark as the icon of `centrifuge in` and `centrifuge out` (white on transparent, from the official SVG).

### Fixed

- Include asynchronous channel evaluation in the publish deadline and cancellation on close; prevent late work from publishing after timeout or redeploy.
- Preserve subscription failures in node status, detach disposed subscription listeners, and share readiness notification across concurrent inputs.
- Validate imported configuration and active editor fields consistently; ignore inactive HMAC settings.
- Snapshot getters and custom JSON hooks once, reject nested binary values in serialized objects, and redact external error and reason text.
- Replace the Proxy serializer with native JSON serialization and a small binary replacer guard. Binary converted by an accessor's own `toJSON` follows native JSON; getters are never re-read.
- Add known protocol descriptions to errors and complete status labels, correcting disconnect 3503/3507 and SDK message-size code 3.
- Settle pending inputs quietly when their owning node closes; preserve CLOSING errors for new inputs after close.
- Test fixtures wait on the server's own ready log line (event-based) plus one bounded connect confirmation instead of polling.

### Testing

- Docker tiers (docs/TESTING.md): TLS with a private CA, connection stall and recovery through `docker pause`, an nginx reverse proxy with path prefix and query string, real static-token expiry; live status badges in the editor against a container; the official Node-RED image with the packed tarball driven end to end from a real browser page. `npm run docker:ensure` installs Docker on Ubuntu when missing.

- Harden Docker tests against early events, partial startup failures and cold-start token expiry; verify query forwarding and a publish dispatched during a stall.
