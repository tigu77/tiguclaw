"use strict";

const test = require("node:test");
const assert = require("node:assert");
// The tests reference the NEW name `calculateTax` — they fail until the rename is done.
const { calculateTax } = require("./tax.js");
const { buildInvoice } = require("./invoice.js");

test("calculateTax computes percentage tax", () => {
  assert.strictEqual(calculateTax(200, 10), 20);
  assert.strictEqual(calculateTax(0, 25), 0);
});

test("calculateTax rejects negative amounts", () => {
  assert.throws(() => calculateTax(-1, 10), RangeError);
});

test("buildInvoice still totals correctly after the rename", () => {
  const inv = buildInvoice([{ price: 100, qty: 2 }, { price: 50, qty: 1 }], 10);
  assert.strictEqual(inv.subtotal, 250);
  assert.strictEqual(inv.tax, 25);
  assert.strictEqual(inv.total, 275);
});
