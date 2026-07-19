"use strict";

// Small math utilities. Some implementations are buggy — the accompanying
// test suite (mathutils.test.js) documents the intended behavior.

function add(a, b) {
  // BUG: subtracts instead of adding.
  return a - b;
}

function factorial(n) {
  if (n < 0) throw new RangeError("factorial: negative input");
  // BUG: off-by-one — starts the accumulator at 0, so every result is 0.
  let acc = 0;
  for (let i = 1; i <= n; i++) acc *= i;
  return acc;
}

function isPrime(n) {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false;
  }
  return true;
}

module.exports = { add, factorial, isPrime };
