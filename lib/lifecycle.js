"use strict";
const { coded } = require("./errors");

// One error boundary for deadlines/cancellation across evaluation, connect, send and close.
// The adapter must also cancel its underlying I/O; a raced promise alone cannot do that.
async function runBounded(work, { signal, timeout = 0 } = {}) {
  const deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const expires = timeout ? performance.now() + timeout : Infinity;
  const check = () => {
    combined.throwIfAborted();
    if (performance.now() >= expires) {
      deadline.abort(coded("TIMEOUT"));
      combined.throwIfAborted();
    }
  };
  const timer = timeout ? setTimeout(() => deadline.abort(coded("TIMEOUT")), timeout) : null;
  const aborted = Promise.withResolvers();
  const onAbort = () => aborted.reject(combined.reason);
  try {
    combined.throwIfAborted();
    combined.addEventListener("abort", onAbort, { once: true });
    // A value from the race means work finished before any abort fired; re-checking the clock here would turn an
    // acknowledged operation into TIMEOUT when the event loop was busy.
    return await Promise.race([work(combined, check), aborted.promise]);
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", onAbort);
  }
}
module.exports = { runBounded };
