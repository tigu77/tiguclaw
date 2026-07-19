"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { parseRecord, normalize, aggregate, summarize } = require("./pipeline.js");

test("stage 1: parseRecord yields numeric values", () => {
  const rec = parseRecord("a=10;b=20;c=30");
  assert.deepStrictEqual(rec, { a: 10, b: 20, c: 30 });
  // strictly numbers, not strings
  assert.strictEqual(typeof rec.a, "number");
});

test("stage 2: normalize clamps to [0, 100]", () => {
  assert.deepStrictEqual(normalize({ a: -5, b: 50, c: 250 }), {
    a: 0,
    b: 50,
    c: 100,
  });
});

test("stage 3: aggregate returns count/sum/mean (mean not truncated)", () => {
  assert.deepStrictEqual(aggregate({ a: 10, b: 20, c: 25 }), {
    count: 3,
    sum: 55,
    mean: 55 / 3,
  });
  assert.deepStrictEqual(aggregate({}), { count: 0, sum: 0, mean: 0 });
});

test("end-to-end: summarize composes all stages correctly", () => {
  // values 10, 250(->100), -5(->0)  => sum 110, count 3, mean 110/3
  assert.deepStrictEqual(summarize("a=10;b=250;c=-5"), {
    count: 3,
    sum: 110,
    mean: 110 / 3,
  });
});
