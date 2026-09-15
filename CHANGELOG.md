# Changelog

All notable changes to this project are documented here. Format: Keep a Changelog. Versioning: semver; breaking changes are called out under **Breaking**.

## [Unreleased]

## [0.1.0] - 2026-09-15

### Added

- `centrifuge-server` config node: HMAC, static token, and anonymous auth modes, one shared connection per configuration, and a message-size preflight setting.
- `centrifuge-in` node: client-side subscribe and server-side subscription modes, join/leave events, and per-channel subscription tokens.
- `centrifuge-out` node: publish with a TypedInput channel selector, `JSON.stringify`-compatible payload rules, and an acknowledgement output.
- `quickstart/centrifugo.yaml`: a commented Centrifugo configuration matching the examples (bind address, port, TLS block to uncomment), plus README steps for running the binary with it and joining the channel from another client.
- Test harness running real Node-RED and a real Centrifugo binary downloaded once into a local fixture.
- Centrifugal logo mark as the icon of `centrifuge in` and `centrifuge out` (white on transparent, from the official SVG).

### Testing

- Docker tiers (docs/TESTING.md): TLS with a private CA, connection stall and recovery through `docker pause`, an nginx reverse proxy with path prefix and query string, real static-token expiry; live status badges in the editor against a container; the official Node-RED image with the packed tarball driven end to end from a real browser page. `npm run docker:ensure` installs Docker on Ubuntu when missing.

- Harden Docker tests against early events, partial startup failures and cold-start token expiry; verify query forwarding and a publish dispatched during a stall.
