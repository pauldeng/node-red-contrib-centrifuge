"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareCommand } = require("../../lib/payload");

const publish = (data, max = 65536) => prepareCommand("publish", { channel: "news" }, data, max);

test("prepareCommand: falsy JSON values pass verbatim; undefined, binary and unserializable rejected", () => {
  for (const v of [null, 0, false, "", [], {}]) assert.deepEqual(publish(v).data, v, JSON.stringify(v));
  for (const bad of [
    undefined,
    Buffer.from("x"),
    new Uint8Array(2),
    { nested: [Buffer.alloc(1)] },
    () => 1,
    Symbol("s"),
    10n,
  ]) {
    assert.throws(
      () => publish(bad),
      (e) => e.code === "INVALID_MESSAGE",
      String(bad),
    );
  }
  const cyc = {};
  cyc.self = cyc;
  assert.throws(
    () => publish(cyc),
    (e) => e.code === "INVALID_MESSAGE",
  );
});

test("prepareCommand: JSON.stringify semantics kept; snapshot defeats a stateful toJSON; size bound counts envelope", () => {
  /* eslint-disable no-sparse-arrays -- holes are the input under test */
  const d = new Date(0);
  assert.equal(publish({ when: d, hole: [1, , 3], nan: NaN, u: undefined }).data.when, d.toJSON());
  assert.deepEqual(publish([1, , 3]).data, [1, null, 3]);
  /* eslint-enable no-sparse-arrays */
  let calls = 0;
  const stateful = { toJSON: () => (++calls === 1 ? "small" : "x".repeat(70000)) };
  const out = publish(stateful);
  assert.equal(out.data, "small");
  assert.equal(JSON.stringify(out.data), '"small"', "snapshot re-serializes without calling toJSON again");
  const { bytes } = publish("a".repeat(100));
  assert.equal(
    bytes,
    Buffer.byteLength(
      JSON.stringify({ publish: { channel: "news", data: "a".repeat(100) }, id: Number.MAX_SAFE_INTEGER }),
    ),
  );
  assert.throws(() => publish("a".repeat(100), bytes - 1), /bytes; the server node allows/);
  assert.equal(publish("é".repeat(10)).bytes - publish("e".repeat(10)).bytes, 10, "UTF-8 bytes, not string length");
});

test("prepareCommand: native JSON parity for frozen, boxed and custom values", () => {
  const values = [
    Object.freeze({ nested: Object.freeze({ x: 1 }) }),
    Object(3),
    Object("a"),
    Object(false),
    Object(Symbol("x")),
    { toJSON: () => Object(7) },
    { toJSON: () => Object("seven") },
    { toJSON: () => new Date(0) },
    Object.assign(Object.create(null), { data: 1 }),
    { toJSON: () => ({ toJSON: () => 10, x: 1 }) },
  ];
  for (const value of values) assert.deepEqual(publish(value).data, JSON.parse(JSON.stringify({ data: value })).data);
  const binary = Object.freeze({ nested: Buffer.alloc(1) });
  assert.throws(
    () => publish(binary),
    (e) => e.code === "INVALID_MESSAGE",
  );
});

test("prepareCommand: BigInt hooks obey native JSON and cannot bypass binary validation", () => {
  const previous = Object.getOwnPropertyDescriptor(BigInt.prototype, "toJSON");
  try {
    BigInt.prototype.toJSON = function () {
      return String(this);
    };
    assert.deepEqual(publish({ n: 7n }).data, { n: "7" });
    BigInt.prototype.toJSON = () => 7n;
    assert.throws(
      () => publish(7n),
      (e) => e.code === "INVALID_MESSAGE",
    );
    assert.throws(
      () => publish({ toJSON: () => 7n }),
      (e) => e.code === "INVALID_MESSAGE",
    );
    BigInt.prototype.toJSON = () => Buffer.alloc(1);
    assert.throws(
      () => publish(7n),
      (e) => e.code === "INVALID_MESSAGE",
    );
  } finally {
    if (previous) Object.defineProperty(BigInt.prototype, "toJSON", previous);
    else delete BigInt.prototype.toJSON;
  }
});

test("native serialization owns accessor conversions; binary data properties remain rejected", () => {
  let reads = 0;
  const value = {
    get data() {
      reads++;
      return Buffer.from("x");
    },
  };
  assert.deepEqual(publish(value).data, { data: { type: "Buffer", data: [120] } });
  assert.equal(reads, 1, "guard never re-evaluates an accessor after native toJSON conversion");
  assert.throws(
    () => publish({ data: Buffer.from("x") }),
    (e) => e.code === "INVALID_MESSAGE",
  );
});
