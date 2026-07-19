"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createClock } = require("./clock.js");
const { createStore } = require("./index.js");
const { KVStore } = require("./store.js");

test("basic set/get/has/delete/size", () => {
  const clock = createClock(1000);
  const s = createStore({ maxSize: 10, clock });
  s.set("a", 1);
  s.set("b", 2);
  assert.strictEqual(s.get("a"), 1);
  assert.strictEqual(s.has("b"), true);
  assert.strictEqual(s.size, 2);
  assert.strictEqual(s.delete("a"), true);
  assert.strictEqual(s.has("a"), false);
  assert.strictEqual(s.get("a"), undefined);
  assert.strictEqual(s.size, 1);
});

test("TTL expiry uses the injected clock", () => {
  const clock = createClock(0);
  const s = createStore({ maxSize: 10, clock });
  s.set("x", "v", 100); // absolute expiry at t=100
  clock.advance(50);
  assert.strictEqual(s.get("x"), "v");
  clock.advance(60); // t=110 > 100
  assert.strictEqual(s.get("x"), undefined);
  assert.strictEqual(s.has("x"), false);
  assert.strictEqual(s.size, 0);
});

test("entries without ttl never expire", () => {
  const clock = createClock(0);
  const s = createStore({ maxSize: 10, clock });
  s.set("k", "v");
  clock.advance(1_000_000_000);
  assert.strictEqual(s.get("k"), "v");
});

test("LRU eviction when exceeding maxSize", () => {
  const clock = createClock(0);
  const s = createStore({ maxSize: 2, clock });
  s.set("a", 1);
  s.set("b", 2);
  s.get("a"); // a becomes most-recently-used
  s.set("c", 3); // exceeds maxSize -> evict LRU (b)
  assert.strictEqual(s.has("a"), true);
  assert.strictEqual(s.has("b"), false);
  assert.strictEqual(s.has("c"), true);
  assert.strictEqual(s.size, 2);
});

test("updating an existing key refreshes recency", () => {
  const clock = createClock(0);
  const s = createStore({ maxSize: 2, clock });
  s.set("a", 1);
  s.set("b", 2);
  s.set("a", 10); // update value + make most-recent
  s.set("c", 3); // evict LRU (b)
  assert.strictEqual(s.get("a"), 10);
  assert.strictEqual(s.has("b"), false);
  assert.strictEqual(s.has("c"), true);
});

test("serialize round-trip preserves values and absolute expiry", () => {
  const clock = createClock(0);
  const s = createStore({ maxSize: 10, clock });
  s.set("a", 1);
  s.set("t", "v", 100); // expires at absolute t=100
  const json = s.toJSON();
  assert.strictEqual(typeof json, "string");

  const clock2 = createClock(50);
  const restored = KVStore.fromJSON(json, { clock: clock2 });
  assert.strictEqual(restored.get("a"), 1);
  assert.strictEqual(restored.get("t"), "v"); // t=50 < 100 still live
  clock2.advance(60); // t=110 > 100
  assert.strictEqual(restored.get("t"), undefined); // now expired
});

test("expired entries drop out of size lazily", () => {
  const clock = createClock(0);
  const s = createStore({ maxSize: 10, clock });
  s.set("a", 1, 10);
  s.set("b", 2, 10);
  s.set("c", 3); // no ttl
  assert.strictEqual(s.size, 3);
  clock.advance(50); // a and b expired
  assert.strictEqual(s.size, 1);
  assert.strictEqual(s.get("a"), undefined);
  assert.strictEqual(s.get("c"), 3);
});
