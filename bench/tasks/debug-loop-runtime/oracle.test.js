"use strict";

// HIDDEN ORACLE — kept in the task dir, NOT in the agent's workspace.
// verify.sh copies this into the temp workspace at verify time, runs it, then
// removes it. The agent never sees these discriminating cases (non-commutative
// operators + nesting), so it must actually RUN its code to converge — and the
// golden answers are never exposed as a static file (idempotent, anti-gaming).

const test = require("node:test");
const assert = require("node:assert");
const { evalRpn } = require("./rpn.js");

test("[oracle] subtracts in RPN operand order", () => {
  assert.strictEqual(evalRpn(["3", "4", "-"]), -1);
});

test("[oracle] divides in RPN operand order", () => {
  assert.strictEqual(evalRpn(["20", "4", "/"]), 5);
});

test("[oracle] nested subtraction", () => {
  assert.strictEqual(evalRpn(["10", "2", "3", "-", "-"]), 11);
});

test("[oracle] divide then subtract", () => {
  assert.strictEqual(evalRpn(["100", "5", "/", "2", "-"]), 18);
});

test("[oracle] still commutative-correct", () => {
  assert.strictEqual(evalRpn(["2", "3", "+", "4", "*"]), 20);
});
