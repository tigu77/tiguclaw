"use strict";

// Tax helpers. NOTE: `computeTax` is the OLD name that must be renamed.
function computeTax(amount, ratePct) {
  if (amount < 0) throw new RangeError("computeTax: negative amount");
  return (amount * ratePct) / 100;
}

module.exports = { computeTax };
