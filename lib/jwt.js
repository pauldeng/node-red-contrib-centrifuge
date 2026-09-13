"use strict";
// HS256 JWT signing for Centrifugo connection and subscription tokens. node:crypto only.
// Claims reference: https://centrifugal.dev/docs/server/authentication and /docs/server/channel_token_auth
const { createHmac } = require("node:crypto");

const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const nowSeconds = () => Math.floor(Date.now() / 1000);

function signHS256(claims, secret) {
  if (typeof secret !== "string" || secret === "") throw new Error("secret must be a non-empty string");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(claims);
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

// Connection token: sub (user id, "" = anonymous), exp/iat in seconds, optional channels (server-side subscriptions).
function connectionToken({ secret, sub = "node-red", ttl = 3600, channels, now = nowSeconds() }) {
  const claims = { sub, iat: now, exp: now + ttl };
  if (Array.isArray(channels) && channels.length) claims.channels = channels;
  return signHS256(claims, secret);
}

// Subscription token: authorizes one client-side subscribe to `channel` for the same subject.
function subscriptionToken({ secret, sub = "node-red", channel, ttl = 3600, now = nowSeconds() }) {
  if (typeof channel !== "string" || channel === "") throw new Error("channel must be a non-empty string");
  return signHS256({ sub, channel, iat: now, exp: now + ttl }, secret);
}

module.exports = { signHS256, connectionToken, subscriptionToken };
