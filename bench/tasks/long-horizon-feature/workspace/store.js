"use strict";

const { serializeEntries, deserializeEntries } = require("./serialize.js");

// TODO(you): implement a KV store with TTL expiry + LRU eviction.
//
// new KVStore({ maxSize, clock })
//   - maxSize: max number of live entries; exceeding it evicts the
//     least-recently-used entry.
//   - clock: a { now() } source (see clock.js) used for TTL.
//
// Methods (exact semantics are pinned by store.test.js):
//   set(key, value, ttlMs?)  ttlMs omitted => never expires. Absolute expiry =
//                            clock.now() + ttlMs. set() counts as a use (makes
//                            the key most-recently-used); updating an existing
//                            key replaces its value and refreshes recency.
//   get(key)                 returns value, or undefined if missing/expired.
//                            A live get() counts as a use (most-recently-used).
//                            Expired entries are pruned lazily on access.
//   has(key)                 true iff key exists and is not expired.
//   delete(key)              removes key; returns true if it existed.
//   get size                 number of live (non-expired) entries.
//   toJSON()                 serialize to a string via serializeEntries.
//   static fromJSON(str, { clock })  rebuild a KVStore from toJSON output,
//                            using the provided clock (absolute expiries kept).
class KVStore {
  constructor(options) {
    void serializeEntries;
    void deserializeEntries;
    throw new Error("KVStore not implemented");
  }
}

module.exports = { KVStore };
