"use strict";

// Invoice builder. Uses the tax helper (via the OLD name `computeTax`).
const { computeTax } = require("./tax.js");

function buildInvoice(items, ratePct) {
  const subtotal = items.reduce((acc, it) => acc + it.price * it.qty, 0);
  const tax = computeTax(subtotal, ratePct);
  return { subtotal, tax, total: subtotal + tax };
}

module.exports = { buildInvoice };
