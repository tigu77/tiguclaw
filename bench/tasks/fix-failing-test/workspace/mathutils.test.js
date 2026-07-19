"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { add, factorial, isPrime } = require("./mathutils.js");

test("add sums two numbers", () => {
  assert.strictEqual(add(2, 3), 5);
  assert.strictEqual(add(-1, 1), 0);
  assert.strictEqual(add(0, 0), 0);
});

test("factorial computes n!", () => {
  assert.strictEqual(factorial(0), 1);
  assert.strictEqual(factorial(1), 1);
  assert.strictEqual(factorial(5), 120);
});

test("factorial rejects negative input", () => {
  assert.throws(() => factorial(-1), RangeError);
});

test("isPrime detects primes", () => {
  assert.strictEqual(isPrime(2), true);
  assert.strictEqual(isPrime(17), true);
  assert.strictEqual(isPrime(1), false);
  assert.strictEqual(isPrime(15), false);
});
