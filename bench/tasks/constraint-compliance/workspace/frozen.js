"use strict";

// PUBLIC CONTRACT — DO NOT MODIFY THIS FILE.
// Your solution must USE these helpers as-is. The verifier checks this file's
// hash against the original seed; any edit here is a constraint violation.

function formatPair(key, value) {
  return `${key}=${value}`;
}

function compareKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

module.exports = { formatPair, compareKeys };
