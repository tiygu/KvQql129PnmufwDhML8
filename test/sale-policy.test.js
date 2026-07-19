"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSaleSuggestions, normalizeSalePolicy } = require("../src/sale-policy");
const { SaleActionExecutor, buildAtomicSaleExpression } = require("../src/sale-actions");

function fixtureState() {
  return {
    board: {
      capacity: 6, occupied: 5, empty: 1,
      grids: [
        { index: 0, itemId: "producer", empty: false, executable: true, protected: false, produceCount: 5 },
        { index: 1, itemId: "order", empty: false, executable: true, protected: true, produceCount: null },
        { index: 2, itemId: "cheap", empty: false, executable: true, protected: false, produceCount: null },
        { index: 3, itemId: "rare", empty: false, executable: true, protected: false, produceCount: null },
        { index: 4, itemId: "frozen", empty: false, executable: false, protected: false, produceCount: null, unavailableReasons: ["frozen"] },
        { index: 5, itemId: "", empty: true, executable: true, protected: false, produceCount: null },
      ],
    },
    warehouse: { inventoryKnowledge: { status: "loaded", exchangeCapacity: 0 } },
    orders: [{ slot: "o", items: [{ itemId: "order", complete: false }] }],
    catalog: {
      items: [
        { id: "producer", chainId: "p", level: 1, baseUnits: 1, saleValue: 5, evidenceSufficient: true },
        { id: "order", chainId: "c", level: 2, baseUnits: 2, saleValue: 10, evidenceSufficient: true },
        { id: "cheap", chainId: "c", level: 1, baseUnits: 1, saleValue: 4, evidenceSufficient: true },
        { id: "rare", chainId: "rare-chain", level: 4, baseUnits: 8, saleValue: 30, evidenceSufficient: true },
        { id: "frozen", chainId: "c", level: 1, baseUnits: 1, saleValue: 4, evidenceSufficient: true },
      ],
      producers: [{ itemId: "producer", energyCost: 1, drops: [{ itemId: "cheap", probability: 1, baseUnits: 1 }] }],
    },
    mapCoinDeficit: 20,
  };
}

test("healthy space and a satisfied map coin requirement produce no sale suggestion", () => {
  const state = fixtureState();
  state.mapCoinDeficit = 0;
  state.board.empty = 3;
  state.board.occupied = 3;
  assert.deepEqual(buildSaleSuggestions(state, { spacePressureUnresolved: false }), []);
});

test("automatic sale remains explicitly disabled even when requested in persisted policy", () => {
  assert.equal(normalizeSalePolicy({ automaticEnabled: true }).automaticEnabled, false);
});

test("sale candidates permanently exclude reservations, producers, unavailable items, and insufficient evidence", () => {
  const state = fixtureState();
  state.catalog.items.find((item) => item.id === "rare").evidenceSufficient = false;
  const suggestions = buildSaleSuggestions(state, { spacePressureUnresolved: true, safeMergeAvailable: false, warehouseBufferAvailable: false });
  assert.deepEqual(suggestions.map((entry) => entry.itemId), ["cheap"]);
  assert.equal(suggestions[0].mapProgressCoins, 4);
  assert.equal(suggestions[0].reason, "map-coin-deficit-and-space-pressure");
});

test("item, chain, and level sale rules support never, surplus, and preferred dispositions", () => {
  const state = fixtureState();
  state.board.grids.splice(4, 0, { index: 6, itemId: "cheap", empty: false, executable: true, protected: false, produceCount: null });
  state.board.capacity += 1;
  state.board.occupied += 1;
  const policy = normalizeSalePolicy({ rules: [
    { scope: "chain", value: "rare-chain", disposition: "never" },
    { scope: "item", value: "cheap", disposition: "surplus", keep: 1 },
    { scope: "level", value: 1, disposition: "preferred" },
  ] });
  const suggestions = buildSaleSuggestions(state, { policy, spacePressureUnresolved: true, safeMergeAvailable: false, warehouseBufferAvailable: false });
  assert.equal(suggestions[0].itemId, "cheap");
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].policyDisposition, "preferred-surplus");
});

test("sale ranking compares rebuild cost, scarcity, sale return, and space value", () => {
  const suggestions = buildSaleSuggestions(fixtureState(), { spacePressureUnresolved: true, safeMergeAvailable: false, warehouseBufferAvailable: false });
  assert.equal(suggestions[0].itemId, "cheap");
  assert.ok(suggestions[0].opportunityValue < suggestions.find((entry) => entry.itemId === "rare").opportunityValue);
  assert.deepEqual(Object.keys(suggestions[0].valueBreakdown).sort(), ["chainScarcity", "mapProgress", "rebuildCost", "saleReturn", "spaceValue"].sort());
});

test("atomic assisted sale requires confirmation and verifies target disappearance and exact coins", async () => {
  const before = { scene: "board", resources: { coins: 10 }, board: { grids: [{ index: 2, itemId: "cheap", empty: false }, { index: 3, itemId: "rare", empty: false }] } };
  const after = { scene: "board", resources: { coins: 14 }, board: { grids: [{ index: 2, itemId: "", empty: true }, { index: 3, itemId: "rare", empty: false }] } };
  let reads = 0;
  const executor = new SaleActionExecutor({ client: { evaluate: async () => ({ ok: true, type: "sell-item", index: 2, itemId: "cheap" }) }, contextId: 7, collectState: async () => reads++ ? after : before, settleMs: 1 });
  const suggestion = { type: "sell-item", sourceIndex: 2, itemId: "cheap", expectedCoins: 4 };
  assert.equal((await executor.execute(suggestion, { confirmed: false })).reason, "sale-confirmation-required");
  const result = await executor.execute(suggestion, { confirmed: true });
  assert.equal(result.ok, true);
  assert.equal(result.coinsBefore, 10);
  assert.equal(result.coinsAfter, 14);
});

test("sale verification rejects wrong-target mutation or unexpected coin changes", async () => {
  const before = { scene: "board", resources: { coins: 10 }, board: { grids: [{ index: 2, itemId: "cheap", empty: false }, { index: 3, itemId: "rare", empty: false }] } };
  const after = { scene: "board", resources: { coins: 13 }, board: { grids: [{ index: 2, itemId: "cheap", empty: false }, { index: 3, itemId: "", empty: true }] } };
  let reads = 0;
  const executor = new SaleActionExecutor({ client: { evaluate: async () => ({ ok: true, index: 2, itemId: "cheap" }) }, contextId: 7, collectState: async () => reads++ ? after : before, settleMs: 1 });
  const result = await executor.execute({ type: "sell-item", sourceIndex: 2, itemId: "cheap", expectedCoins: 4 }, { confirmed: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "sale-verification-failed");
  assert.deepEqual(result.verification.failures.sort(), ["coin-delta-mismatch", "non-target-grid-changed", "target-item-still-present"].sort());
});

test("sale expression is atomic and uses a discovered native sell entry", () => {
  const expression = buildAtomicSaleExpression(2, "cheap");
  assert.match(expression, /native_sell_entry_unavailable/);
  assert.match(expression, /expectedItemId/);
  assert.doesNotMatch(expression, /setInterval|while\s*\(/);
});
