"use strict";

// A small data-processing pipeline: parse -> normalize -> aggregate.
// Each stage has an independent bug. The stages are sequentially dependent:
// the end-to-end `summarize` result is only correct once ALL stages are fixed,
// so you must fix a bug, re-run the tests, discover the next failure, and repeat
// until the whole suite is green. Fix pipeline.js only; do not edit the tests.

// Stage 1 — parse a "k=v;k=v" record string into an object of numbers.
function parseRecord(line) {
  const out = {};
  for (const pair of line.split(";")) {
    if (pair === "") continue;
    const [k, v] = pair.split("=");
    // BUG 1: values are left as strings; downstream math then concatenates.
    out[k] = v;
  }
  return out;
}

// Stage 2 — normalize: clamp every value into the [0, 100] range.
function normalize(rec) {
  const out = {};
  for (const k of Object.keys(rec)) {
    let v = rec[k];
    if (v < 0) v = 0;
    // BUG 2: upper clamp uses the wrong bound (1000 instead of 100).
    if (v > 1000) v = 1000;
    out[k] = v;
  }
  return out;
}

// Stage 3 — aggregate: return { count, sum, mean } over the values.
function aggregate(rec) {
  const values = Object.values(rec);
  const count = values.length;
  let sum = 0;
  for (const v of values) sum += v;
  // BUG 3: integer division-style truncation is wrong; also guards count===0 badly.
  const mean = count === 0 ? 0 : Math.trunc(sum / count);
  return { count, sum, mean };
}

// End-to-end.
function summarize(line) {
  return aggregate(normalize(parseRecord(line)));
}

module.exports = { parseRecord, normalize, aggregate, summarize };
