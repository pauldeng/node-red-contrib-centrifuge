# Architecture

Read this for connection, subscription, publish or lifecycle changes. User-facing fields and messages are documented in [README.md](../README.md) and the node help; this document explains their implementation and ownership.

## Components

| Component                                                    | Responsibility                                                                                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [centrifuge-server.js](../nodes/centrifuge-server.js)        | Config node: validates configuration, exposes consumer registration and delegates to the connection owner.                                                              |
| [connection.js](../lib/connection.js)                        | One SDK client, connection status, shared subscription registry, readiness waiters and command execution.                                                               |
| [centrifuge-in.js](../nodes/centrifuge-in.js)                | Client-side or server-side subscription consumer; turns publications and selected join/leave events into flow messages.                                                 |
| [centrifuge-out.js](../nodes/centrifuge-out.js)              | Evaluates a channel per input, prepares its payload, publishes and forwards the original message after acknowledgement. Owns pending input cancellation and settlement. |
| [lifecycle.js](../lib/lifecycle.js)                          | Shared deadline and cancellation boundary.                                                                                                                              |
| [payload.js](../lib/payload.js)                              | JSON snapshot, binary guard and publish-command size preflight.                                                                                                         |
| [jwt.js](../lib/jwt.js)                                      | HS256 connection and subscription tokens using `node:crypto`.                                                                                                           |
| [errors.js](../lib/errors.js), [status.js](../lib/status.js) | Public error codes, local diagnostic labels and status rendering.                                                                                                       |

## Ownership and lifecycle

- A valid config creates its SDK client immediately; the first registered consumer starts the connection. Removing the last consumer does not disconnect it. The config node owns it until close.
- Consumers use the config node's `register`/`deregister`, `subscribe(channel, consumer, options)`, `onServerSide(consumer)` and `run(work, { signal, prepare })`. Subscription methods return disposers. Keep direct SDK access inside the connection owner and the work callback passed to `run`.
- Consumers sharing a channel use one SDK subscription. The subscription always requests join/leave (the server only sends them where the namespace enables them) and events are filtered per consumer, so opting in never recreates the subscription or drops publications. Server-side/client-side overlap is `CONFIG_CONFLICT`.
- Connection close aborts pending work, removes owned client listeners, calls `disconnect()`, then destroys subscriptions so removal sends no unsubscribe commands. It does not await a network acknowledgement. Keep the SDK's default `error` listener; do not use `removeAllListeners()`.
- Output-node close aborts its inputs, waits for their local settlement and deregisters. Inputs cancelled by their own node closing settle quietly; late completion must not send a message. Partial redeploy must leave sibling consumers and their shared connection working.

## Publish path

1. Resolve the configured channel selector with `RED.util.evaluateNodeProperty`; validate the channel and payload inside the same error boundary.
2. `prepareCommand` serialises the command envelope with the binary guard, measures UTF-8 bytes with a conservative command-id allowance, and parses a JSON snapshot. The SDK later serialises that snapshot for transport. This preserves one evaluation of getters and `toJSON`; it is not a single serialisation end to end. See the README's payload rules for the binary/accessor boundary.
3. Wait for a connecting client, or fail promptly for a terminal connection. Preparation, readiness and acknowledgement share one total deadline. Check cancellation/deadline again before dispatch so delayed evaluation cannot publish after expiry.
4. On acknowledgement, replace `msg.centrifuge` with the publish result metadata, preserve other properties and settle once. Errors reach Catch through `done(error)` as `msg.error.code`.

There is no package offline queue or publish retry. A command already sent can still arrive after the caller times out; cancellation cannot retract it. Concurrent inputs may complete out of order.

`maxMessageSize` checks each prepared publish command against the configured server limit. It does not bound SDK-generated connect/subscribe commands or an SDK batch containing several commands. Oversized frames can terminate the shared connection, so do not describe the preflight as an absolute connection-safety guarantee.

## Status and diagnostics

- Connection and subscription status are distinct: an established connection does not mean a channel is subscribed. Use the owner's subscription status for an input node.
- Yellow rings represent transient or awaiting states; red rings represent terminal/configuration failures. The renderer suppresses consecutive identical statuses and logs a terminal transition through `node.error` without a message, so that log does not trigger Catch.
- Status and Catch errors use local labels from the code tables, never raw server, SDK or serialization exception text. Keep SDK and server numeric code namespaces distinct.
- Secrets belong to Node-RED credentials. Validate active auth settings, URL restrictions, channel lists and imported values at runtime; the editor is not a trust boundary.

## Dependency assumptions

When changing a dependency pin or the behaviour below, inspect the installed dependency source and run the relevant [tests](TESTING.md). Do not rely on local design reports or old test results as current evidence.

- Refused subscriptions can transition directly to `unsubscribed`; an `error` handler alone misses them.
- Retryable connection loss appears as `connecting`; `disconnected` is terminal. The wrapper must avoid the SDK's readiness timeout when the connection is already terminal.
- Native Node.js `WebSocket` supplies the transport. Private CAs use `NODE_EXTRA_CA_CERTS` at process startup; there are no per-config-node TLS options.
- SDK debug-flag access to `localStorage` may produce a Node.js experimental-webstorage warning depending on the runtime. Check failures separately from this warning.
- `disconnect()` does not cancel the SDK's pending connect-command timer; one timer handle per connect/close cycle lives on until the configured `timeout` elapses, then clears itself. Bounded, so redeploy loops never hold more than one timeout window of handles.
