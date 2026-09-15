# @pauldeng/node-red-contrib-centrifuge

Node-RED nodes for Centrifugo over the official JavaScript client, WebSocket transport, JSON protocol. Every node that selects the same server configuration shares one connection.

## Install

In your Node-RED user directory (`~/.node-red`), or through the palette manager once the package is listed in the Flow Library:

```
npm install @pauldeng/node-red-contrib-centrifuge
```

From a checkout instead, run `npm install /path/to/node-red-contrib-centrifuge` in the same directory. Requirements: see `engines` and the `node-red` block in `package.json` for the supported Node.js and Node-RED versions, and Centrifugo v6 (tested against the pinned binary the test fixture downloads).

## Quick start

You need a Centrifugo v6 server that lets clients subscribe and publish on the default namespace. A ready configuration lives in [`quickstart/centrifugo.yaml`](https://github.com/pauldeng/node-red-contrib-centrifuge/blob/main/quickstart/centrifugo.yaml).

1. Edit `quickstart/centrifugo.yaml` and set `client.token.hmac_secret_key` to a long random value. Easy sources: `centrifugo genconfig -c fresh.json` prints a generated one, your password manager can generate one, or a UUID from a generator site such as [uuidgenerator.net](https://www.uuidgenerator.net) (fine for a local trial; keep production secrets local).
2. Get the Centrifugo binary for your platform from the [releases page](https://github.com/centrifugal/centrifugo/releases) (in a checkout of this repository, `npm run fixture` downloads the pinned version into `.cache/centrifugo/`) and start it:

   ```
   centrifugo --config quickstart/centrifugo.yaml
   ```

   It listens on `ws://localhost:8000/connection/websocket`, and `http://localhost:8000/health` answers `{}` once it is up. The file is commented: bind address and port under `http_server`, a TLS block to uncomment for `wss://`, and the namespace permissions the nodes rely on.

3. In Node-RED import `01-subscribe-and-publish` (menu, Import, Examples, this package), open the `centrifuge server` configuration node, paste the same secret into **Secret**, and deploy. The `centrifuge in` node shows `subscribed`.
4. Click the inject button: the message is published on `news` and arrives back through `centrifuge in` in the debug sidebar.

`02-server-side-subscriptions` shows the alternative: channels granted through the connection token instead of a client-side subscribe request. `03-request-rpc-history-presence` adds `centrifuge request` nodes: history and presence stats on `news`, and an RPC call to method `echo` (needs the commented `rpc:` block in `quickstart/centrifugo.yaml` enabled, plus a backend implementing the RPC proxy protocol). All examples use the same server configuration.

### Try it from another client

Any Centrifugo client can join the same channel. With Postman or another WebSocket tool, connect to `ws://localhost:8000/connection/websocket` and send a connect command carrying a token signed with the same secret:

```
centrifugo gentoken -c quickstart/centrifugo.yaml -u postman -t 86400
```

```
{"connect":{"token":"<token>"},"id":1}
{"subscribe":{"channel":"news"},"id":2}
```

Injecting in Node-RED now delivers `{"push":{"channel":"news","pub":{"data":{"hello":"world"}}}}` to that client, and sending `{"publish":{"channel":"news","data":{"from":"postman"}},"id":3}` from it appears in the Node-RED debug sidebar. Answer each server ping `{}` with `{}`, or the server drops the connection after its pong timeout.

## Nodes

### centrifuge server (`centrifuge-server`, config)

One shared connection per configuration, opened when the first node using it is deployed and kept until the configuration is redeployed or removed.

| Field            | Default                                    | Meaning                                                                                                                                                             |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | _(empty)_                                  | Optional label.                                                                                                                                                     |
| `url`            | `ws://localhost:8000/connection/websocket` | The bidirectional WebSocket endpoint (`ws://` or `wss://`). Credentials in the URL are rejected; query parameters allowed; `${NAME}` expands environment variables. |
| `auth`           | `hmac`                                     | `hmac`, `token`, or `none` — see below.                                                                                                                             |
| `user`           | `node-red`                                 | The connection token's `sub` claim (HMAC mode only).                                                                                                                |
| `channels`       | _(empty)_                                  | One channel per line (HMAC mode only); becomes the token's `channels` claim — the server subscribes the connection to them server-side.                             |
| `ttl`            | `3600`                                     | Connection token lifetime in seconds, 60–86400 (HMAC mode only); renewed before expiry.                                                                             |
| `token`          | _(none)_                                   | A pre-generated JWT (Static JWT mode only), stored as a credential.                                                                                                 |
| `timeout`        | `5000`                                     | Total publish deadline in milliseconds, including channel evaluation, connection readiness and acknowledgement.                                                     |
| `maxMessageSize` | `65536`                                    | Upper bound in bytes for outgoing commands; must not exceed the server's `websocket.message_size_limit`.                                                            |

Auth modes:

- **HMAC secret** — Node-RED holds the server's `client.token.hmac_secret_key` and signs HS256 tokens itself, renewing them before `ttl` expires. Holding the secret lets Node-RED mint a token for any user and channel, so use this mode only where Node-RED is trusted like your backend.
- **Static JWT** — a token generated elsewhere. Nothing refreshes it: when it expires the connection ends with `disconnected: unauthorized (1)` and stays down until redeployed with a new token.
- **None (anonymous)** — connects without a token; the server must set `client.allow_anonymous_connect_without_token`.

`timeout` bounds each publish from channel evaluation through acknowledgement and also sets the SDK timeout per phase; there is no offline queue, so a publish issued while reconnecting fails after `timeout` with `TIMEOUT`. `maxMessageSize` checks each publish command locally before sending: an oversized command would make the server close the shared connection permanently, so the output node refuses it with `INVALID_MESSAGE`. This preflight does not limit SDK-generated connect or subscribe commands; keep token channel lists within the server limit.

### centrifuge in (`centrifuge-in`)

Receives publications from a Centrifugo channel. One output, no input.

**Mode** selects how the node subscribes:

- `subscribe` — a client-side subscription to **Channel**, created and torn down by this node. Two `centrifuge in` nodes subscribed to the same channel on the same server share one underlying subscription. Join and leave events reach only the nodes that enable **Also receive join/leave events**; a node opting in later does not disturb the shared subscription. A **subscription token** (`subscriptionAuth: hmac`) adds a per-channel HMAC token, for namespaces that require a signed subscription; it needs HMAC auth on the server node.
- `server` — reads from subscriptions the server already granted this connection through the server node's **Channels** list. **Channel** here is an optional exact-match filter: blank receives every granted channel, set receives only one. Status shows `awaiting server subscription` (yellow) while connected but not yet granted that channel.

A channel cannot be both in the server node's **Channels** list and used by a `subscribe`-mode node on the same server: that combination is rejected as a conflicting subscription.

Output message shape:

- `msg.topic` — the channel the message came from.
- `msg.payload` — the publication data as received (any JSON value, including `null`), or the `ClientInfo` object for a join/leave event.
- `msg.centrifuge` — `{ event, channel, offset?, tags?, info? }`. `event` is `publication`, `join`, or `leave`; `offset` and `tags` are omitted when the server did not send them (an offset of `0` is kept); `info` is present for join/leave and for a publication the server tagged with sender info.

### centrifuge out (`centrifuge-out`)

Publishes `msg.payload` on a Centrifugo channel and passes the message on once the server has acknowledged it.

**Channel** is a TypedInput selector (default `msg.topic`, also flow/global/string/env/JSONata), evaluated for every message; it must resolve to a non-empty string.

Payload rules: objects are JSON-encoded exactly as `JSON.stringify` would (Dates become strings, `undefined` properties are dropped, a stateful custom `toJSON` is snapshotted once). `null`, `0`, `false`, `""`, `[]`, and `{}` are published verbatim. `undefined`, stored binary data properties (including nested Buffer and typed arrays), and binary values seen by the JSON replacer are rejected with `INVALID_MESSAGE`. The guard does not re-evaluate getters: a getter returning a Buffer whose `toJSON` has already converted it uses that JSON representation. Custom serialization is responsible for its JSON output.

Output: `msg.centrifuge = { action: "publish", channel }`, replacing any previous `msg.centrifuge`; all other message properties are preserved.

There is no offline queue: while the shared connection is reconnecting, a publish waits at most the server node's `timeout` before failing with `TIMEOUT`; a permanently failed connection fails immediately with `NOT_CONNECTED`. Nothing caps how many publishes wait at once, so during a reconnect the node holds roughly input rate × `timeout` messages in memory; rate-limit bursty flows with a Delay node upstream. Acknowledgement means the server accepted the publication, not that any subscriber received it — a command that times out may still have been delivered, and concurrent inputs may complete out of order.

Commands larger than the server node's `maxMessageSize` are refused locally (a size preflight) with `INVALID_MESSAGE`, before anything is sent.

### centrifuge request (`centrifuge-request`)

Sends one request to Centrifugo per message and passes the message on with the result in `msg.payload`: an RPC call through the server's RPC proxy, or a channel's history, presence, or presence stats.

**Action** (`rpc`, `history`, `presence`, or `presence_stats`) is fixed in the node's configuration; a message cannot switch it. The RPC **Method** or the **Channel** is a TypedInput selector (default `msg.topic`, also flow/global/string/env/JSONata), evaluated for every message; it must resolve to a non-empty string.

Input `msg.payload`:

- `rpc` — the request data, required (send `null` for a call without data); the JSON rules of `centrifuge out` apply.
- `history` — an optional plain options object `{ limit, since: { offset, epoch }, reverse }`: `limit` is a non-negative safe integer (default 100), `since` needs a non-negative safe integer `offset` and a non-empty string `epoch`, `reverse` is a boolean; other keys (including inside `since`) or a non-plain-object payload fail with `INVALID_MESSAGE`.
- `presence` and `presence_stats` — ignored.

Output: `msg.payload` is the result, replacing the input payload — `rpc`: the data returned by the backend. `history`: `{ publications, offset, epoch }`, each publication `{ channel, data, offset, info? }`. `presence`: `{ clients }` keyed by client id. `presence_stats`: `{ numUsers, numClients }`. `msg.centrifuge = { action: "rpc", method }` for RPC calls, `{ action, channel }` for the channel actions, replacing any previous `msg.centrifuge`; all other message properties are preserved.

`rpc` needs an RPC proxy configured on the Centrifugo side (`rpc.proxy.endpoint` and `rpc.without_namespace.proxy_enabled`, or an `rpc.namespaces` entry) — see [Centrifugo proxy](https://centrifugal.dev/docs/server/proxy). `history` needs `history_size` and `history_ttl` plus `allow_history_for_client` on the channel's namespace — see [history and recovery](https://centrifugal.dev/docs/server/history_and_recovery). `presence` and `presence_stats` need `presence: true` plus `allow_presence_for_client` — see [presence](https://centrifugal.dev/docs/server/presence). A feature the namespace does not enable answers server code 108, an unknown namespace answers code 102 (see [server error codes](https://centrifugal.dev/docs/server/codes)).

Deadlines, size preflight, the absence of an offline queue, and cancellation on close behave exactly as for `centrifuge out`.

## Status badges

| Status                               | Colour / shape     | Meaning                                                                                    |
| ------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------ |
| `connecting`                         | yellow ring        | Client is connecting or retrying.                                                          |
| `connected`                          | green dot          | Connection is up.                                                                          |
| `disconnected: reason (code)`        | red ring, terminal | The server or the token ended the connection permanently; fix the cause and redeploy.      |
| `invalid config: detail`             | red ring, terminal | The configuration node's settings are invalid.                                             |
| `missing server`                     | red ring, terminal | A node has no server configuration selected.                                               |
| `subscribing`                        | yellow ring        | A client-side subscription is being (re)established.                                       |
| `subscribed`                         | green dot          | A client-side subscription is active.                                                      |
| `unsubscribed: reason (code)`        | red ring, terminal | The server refused or ended the subscription; it does not retry.                           |
| `awaiting server subscription`       | yellow ring        | Connected, but the server has not (yet) granted this channel server-side.                  |
| `conflict: <channel> is server-side` | red ring, terminal | A `subscribe`-mode node names a channel that the server node already lists under Channels. |

Yellow = the client is retrying or waiting. Red and terminal = the condition will not resolve itself; fix the cause and redeploy.

## Errors and troubleshooting

Every runtime error carries a code from a closed set, available at `msg.error.code` through a Catch node.

| Code                | Symptom                                                                               | Cause                                                                                                                                                                                                                                                                                                                | Fix                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `MISSING_SERVER`    | Node fails immediately, status `missing server`.                                      | No server configuration selected on the node.                                                                                                                                                                                                                                                                        | Select a `centrifuge server` configuration.                                                     |
| `INVALID_CONFIG`    | Status `invalid config: ...`.                                                         | The server configuration's settings (URL, auth, ranges) failed validation.                                                                                                                                                                                                                                           | Fix the configuration and redeploy.                                                             |
| `CONFIG_CONFLICT`   | `centrifuge in` shows `conflict: <channel> is server-side`; a publish fails on input. | The same channel is used both in the server node's Channels list and by a `subscribe`-mode `centrifuge in` node.                                                                                                                                                                                                     | Remove the channel from one of the two places.                                                  |
| `NOT_CONNECTED`     | Publish or subscribe fails immediately.                                               | The shared connection has permanently failed (a terminal status).                                                                                                                                                                                                                                                    | Fix the underlying cause shown in the status and redeploy.                                      |
| `TIMEOUT`           | Operation fails after the configured `timeout`.                                       | The server did not reply in time, or a publish was issued while reconnecting.                                                                                                                                                                                                                                        | Check server reachability; increase `timeout` if the server is legitimately slow.               |
| `INVALID_MESSAGE`   | Publish or a `centrifuge request` is rejected before anything is sent.                | Payload is `undefined`, binary, or larger than `maxMessageSize`; for a `history` request, the options object failed validation (bad `limit`, `since`, `reverse`, or an unknown key).                                                                                                                                 | Send a JSON-serializable, non-binary payload within the size limit; fix the `history` options.  |
| `CLOSING`           | Operation rejected while a node or configuration is being redeployed/removed.         | The node is shutting down.                                                                                                                                                                                                                                                                                           | Pending inputs cancelled by their own node closing settle quietly; new inputs after close fail. |
| `UNAUTHORIZED`      | A publish or subscribe is rejected as unauthorized.                                   | The server answered with code 101 or 109 (token expired), or a token refresh failed. A wrong secret instead ends the connection with `disconnected: invalid token (3500)` and inputs fail `NOT_CONNECTED`.                                                                                                           | Check the secret or token; see the clock-skew and token entries below.                          |
| `PERMISSION_DENIED` | Subscribe, publish, or a `centrifuge request` is refused by the server.               | The channel's namespace lacks `allow_subscribe_for_client` / `allow_publish_for_client` (or `_for_subscriber`); for `centrifuge request`, `allow_history_for_client` or `allow_presence_for_client`.                                                                                                                 | Grant the permission on the namespace, or use a subscription token.                             |
| `SERVER_ERROR`      | Publish, subscribe, or a `centrifuge request` fails with a server-side error.         | Centrifugo returned a command error; the message includes "server code N". For `centrifuge request`, code 108 means the feature is not enabled on the namespace (or `rpc` has no proxy configured), code 102 means an unknown namespace, and an RPC backend error reply carries its own numeric code in the message. | Look up the numeric code in the Centrifugo server error reference.                              |
| `SDK_ERROR`         | An error not covered by another code.                                                 | An unrecognised client-library rejection.                                                                                                                                                                                                                                                                            | Check server logs; may indicate an SDK or protocol issue.                                       |

Errors and statuses use known protocol descriptions and numeric codes (for example, `server code 102: unknown channel`). Unknown custom codes retain the number; consult backend logs for their meaning. Raw server reasons and SDK messages are omitted to keep credentials and payloads out of diagnostics.

Other messages:

- **`ExperimentalWarning: localStorage is not available because --localstorage-file was not provided`** — harmless. The client library reads a browser debug flag once per connection. Suppress it with `NODE_OPTIONS=--no-experimental-webstorage` or `--no-warnings=ExperimentalWarning` on the Node-RED process.
- **Status shows `connecting` forever** — the server is unreachable, or the URL/port is wrong; the client keeps retrying with backoff.
- **`disconnected: invalid token (3500)`** — wrong secret, or a static token the server rejects.
- **`unsubscribed: permission denied (103)`** — the namespace lacks `allow_subscribe_for_client`, or needs a subscription token.
- **Publishing fails with `PERMISSION_DENIED`** — the namespace lacks `allow_publish_for_client` / `allow_publish_for_subscriber`; Centrifugo recommends the HTTP server API for backend publishing instead.
- **Self-signed certificate / custom CA on `wss://`** — Node's native WebSocket has no per-connection TLS options; set `NODE_EXTRA_CA_CERTS` on the Node-RED process.
- **Clock skew** — tokens signed by Node-RED need NTP-synced clocks; a large skew can make a freshly signed token look expired or not-yet-valid to the server.

## Not supported (by design)

- SockJS (deprecated and removed in Centrifugo v6).
- SSE, HTTP-stream, or WebTransport fallback transports.
- Protobuf and binary payloads.
- Delta compression.
- An offline queue or automatic retry of publishes.
- Persisted stream position across restarts — the client recovers only within the process lifetime, and only when the namespace enables recovery.
- OpenTelemetry (planned; off by default when it arrives).
- Custom TLS options.

## Development

From the checkout root, run `npm ci` with a supported Node.js version. No build step is required. Contributor guidance starts in [AGENTS.md](AGENTS.md); [docs/TESTING.md](docs/TESTING.md) covers setup, test selection, fixtures and known coverage gaps.

- `npm run fixture` — download and verify the pinned Centrifugo binary into `.cache/`.
- `npm run check` — package sanity, editor contract, and async-style gates.
- `npm test` — checks, unit, and runtime tests.
- `npm run test:unit` / `npm run test:runtime` — focused tiers; run `npm run fixture` before a direct runtime run on a fresh checkout.
- `npm run lint` / `npm run format:check`.
- `npm run test:e2e` — editor dialog checks in a real browser (Playwright, no Docker); install Chromium first with `npx playwright install chromium`.
- `npm run docker:ensure` — optional Ubuntu host provisioning; can install Docker and change system packages, services and group membership.
- `npm run test:docker`, `npm run test:ui`, `npm run test:e2e:browser` — Docker tiers: TLS, stalls and a reverse proxy against a Centrifugo container; live status badges in the editor; a real browser page talking to a flow through the official Node-RED image. `npm run test:docker:all` runs all three. See `docs/TESTING.md`.

The default `npm test` uses a real Node-RED child process and a Centrifugo binary downloaded once into `.cache/`; the separately invoked Docker tiers need daemon access for the current user.

## License

MIT, see [LICENSE](LICENSE).
