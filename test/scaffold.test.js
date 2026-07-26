"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeId } = require("../src/scaffold");

test("normalizes adapter identifiers", () => {
  assert.equal(normalizeId("My New Game"), "my-new-game");
  assert.throws(() => normalizeId("---"));
});
