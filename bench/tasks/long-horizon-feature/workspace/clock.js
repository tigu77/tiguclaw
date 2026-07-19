"use strict";

// A controllable clock (COMPLETE — use as-is). Production code passes a real
// clock whose now() returns Date.now(); tests inject a fake and call advance().
function createClock(initial = 0) {
  let t = initial;
  return {
    now() {
      return t;
    },
    advance(ms) {
      t += ms;
    },
  };
}

module.exports = { createClock };
