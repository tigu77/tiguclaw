"use strict";

// TODO(you): implement these two functions.
//
// serializeEntries(entries): `entries` is an array of [key, record] pairs, where
//   record = { value, expiresAt }. `expiresAt` is an absolute timestamp in ms,
//   or null for no-expiry. Return a JSON string that captures all pairs in order.
//
// deserializeEntries(str): the inverse — parse the string produced by
//   serializeEntries back into the same array-of-[key, {value, expiresAt}] shape,
//   preserving order.
function serializeEntries(entries) {
  throw new Error("serializeEntries not implemented");
}

function deserializeEntries(str) {
  throw new Error("deserializeEntries not implemented");
}

module.exports = { serializeEntries, deserializeEntries };
