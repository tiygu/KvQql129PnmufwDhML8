"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeCatalogs } = require("../src/automation-runtime");

test("运行时重新扫描只更新当前合成链且保留既有图鉴", () => {
  const base = { rules: {}, chains: [{ id: "a", complete: false }, { id: "b", complete: true }], items: [{ id: "a1", chainId: "a", level: 1 }, { id: "b1", chainId: "b", level: 1 }], producers: [{ itemId: "p1" }] };
  const update = { rules: {}, chains: [{ id: "a", complete: true, maxLevel: 2 }], items: [{ id: "a2", chainId: "a", level: 2 }], producers: [{ itemId: "p2" }] };
  const merged = mergeCatalogs(base, update);
  assert.deepEqual(merged.chains.map((item) => [item.id, item.complete]), [["a", true], ["b", true]]);
  assert.deepEqual(merged.items.map((item) => item.id), ["a1", "a2", "b1"]);
  assert.deepEqual(merged.producers.map((item) => item.itemId), ["p1", "p2"]);
  assert.deepEqual(merged.coverage.incompleteChains, []);
});
