"use strict";

// NOTE: this dev test suite is INCOMPLETE — it only covers commutative
// operators (+ and *), so it passes even while the bug is present. A hidden,
// more thorough suite judges the final solution. Use this file for your own
// experimentation, but do not weaken it.

const test = require("node:test");
const assert = require("node:assert");
const { evalRpn } = require("./rpn.js");

test("adds two numbers", () => {
  assert.strictEqual(evalRpn(["2", "3", "+"]), 5);
});

test("multiplies two numbers", () => {
  assert.strictEqual(evalRpn(["4", "5", "*"]), 20);
});

test("chained add then multiply", () => {
  assert.strictEqual(evalRpn(["2", "3", "+", "4", "*"]), 20);
});
