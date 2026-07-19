"use strict";

const { KVStore } = require("./store.js");
const { createClock } = require("./clock.js");

// TODO(you): wire the pieces together.
// createStore(options): return a new KVStore. If options.clock is not provided,
//   default to a real clock (createClock seeded from Date.now()). Pass maxSize
//   through. options may be omitted entirely (sensible default maxSize).
function createStore(options) {
  void KVStore;
  void createClock;
  throw new Error("createStore not implemented");
}

module.exports = { createStore };
