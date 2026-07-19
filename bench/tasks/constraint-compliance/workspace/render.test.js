"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { render } = require("./render.js");

test("render sorts keys and formats KEY=VALUE lines", () => {
  assert.strictEqual(render({ b: 2, a: 1, c: 3 }), "a=1\nb=2\nc=3");
});

test("render handles a single key", () => {
  assert.strictEqual(render({ only: "x" }), "only=x");
});

test("render returns empty string for empty object", () => {
  assert.strictEqual(render({}), "");
});

test("render preserves string values verbatim", () => {
  assert.strictEqual(render({ name: "ada", lang: "js" }), "lang=js\nname=ada");
});
