"use strict";
const { types } = require("node:util");
const { coded } = require("./errors");

const ID_ALLOWANCE = Number.MAX_SAFE_INTEGER; // conservative 16-digit command-id allowance

const isBinary = (value) => Buffer.isBuffer(value) || ArrayBuffer.isView(value) || types.isAnyArrayBuffer(value);

// Let JSON.stringify own traversal, getters, toJSON and primitive conversion. The holder's data descriptor
// retains ordinary Buffer properties after Buffer.toJSON has run, without invoking a getter a second time.
function rejectBinary(key, value) {
  const original = Object.getOwnPropertyDescriptor(this, key)?.value;
  if (isBinary(original) || isBinary(value))
    throw coded("INVALID_MESSAGE", "binary payloads are not supported with the JSON protocol");
  return value;
}

function prepareCommand(method, params, data, maxMessageSize) {
  if (data === undefined) throw coded("INVALID_MESSAGE", "payload is required");
  let text;
  try {
    text = JSON.stringify({ [method]: { ...params, data }, id: ID_ALLOWANCE }, rejectBinary);
  } catch {
    // Getter/toJSON exceptions and native cycle diagnostics can contain payloads or credentials.
    throw coded("INVALID_MESSAGE", "payload must be JSON-serializable and contain no binary values");
  }
  const bytes = Buffer.byteLength(text);
  if (bytes > maxMessageSize)
    throw coded("INVALID_MESSAGE", `command is ${bytes} bytes; the server node allows ${maxMessageSize}`);
  const parsed = JSON.parse(text);
  if (!("data" in parsed[method])) throw coded("INVALID_MESSAGE", "payload produces no JSON value");
  return { data: parsed[method].data, bytes };
}

module.exports = { prepareCommand };
