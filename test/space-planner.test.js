"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  normalizePlannerState,
  simulateDeterministicTransition,
  planDeterministicOrder,
  comparePathScores,
} = require("../src/space-planner");
const { buildOptimizationPlan } = require("../src/order-optimizer");

const execFileAsync = promisify(execFile);

function fixture({ grids, empty, orderItem = "b2", energy = 3, frozen = false } = {}) {
  return {
    catalog: {
      items: [
        { id: "x1", chainId: "x", level: 1, baseUnits: 1, mergeTarget: "x2" },
        { id: "x2", chainId: "x", level: 2, baseUnits: 2, mergeTarget: null },
        { id: "b1", chainId: "b", level: 1, baseUnits: 1, mergeTarget: "b2" },
        { id: "b2", chainId: "b", level: 2, baseUnits: 2, mergeTarget: null },
        { id: "p", chainId: "producer", level: 1, baseUnits: 1, mergeTarget: null },
      ],
      producers: [{ itemId: "p", energyCost: 1, drops: [{ itemId: "b1", probability: 1, baseUnits: 1 }] }],
      evidence: { objects: [{ objectType: "item-identity", objectId: "b2", status: "active", disposition: "enabled" }] },
    },
    state: {
      schemaVersion: 1,
      scene: "board",
      resources: { coins: 5, energy },
      board: {
        width: 4, height: 1, occupied: grids.length, empty,
        grids: grids.map((grid, index) => ({ index, normal: true, moveable: true, ...grid, ...(frozen && index === 1 ? { frozen: true } : {}) })),
        mergeCandidates: [], requiredItemCounts: { [orderItem]: 1 },
      },
      orders: [{ slot: "o", rewardCoins: 20, ready: false, items: [{ itemId: orderItem, complete: false }] }],
      mapMission: { requirements: [{ resourceType: 1, current: 5, required: 30, deficit: 25 }] },
      warehouse: { loaded: false, occupiedSlots: 0, totalSlots: 2 },
    },
  };
}

test("normalized planner state is immutable and contains board, executable, order, energy, map, catalog, and protection facts", () => {
  const input = fixture({ grids: [{ itemId: "p", produceCount: 2, energyCost: 1 }, { itemId: "b1" }], empty: 2 });
  const normalized = normalizePlannerState({ ...input, protectionRules: { itemIds: ["x1"] } });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.board.grids), true);
  assert.equal(normalized.board.capacity, 4);
  assert.equal(normalized.board.grids[0].executable, true);
  assert.equal(normalized.orders[0].slot, "o");
  assert.equal(normalized.energy, 3);
  assert.equal(normalized.mapCoinDeficit, 25);
  assert.equal(normalized.catalog.evidence[0].status, "active");
  assert.deepEqual(normalized.protection.itemIds, ["x1"]);
  assert.throws(() => { normalized.energy = 99; }, TypeError);
});

test("deterministic merge and submission transitions are exact and conserve merge material", () => {
  const input = fixture({ grids: [{ itemId: "b1" }, { itemId: "b1" }], empty: 2 });
  const normalized = normalizePlannerState(input);
  const merged = simulateDeterministicTransition(normalized, { type: "merge", from: 0, to: 1 });
  assert.equal(merged.ok, true);
  assert.equal(merged.state.board.occupied, 1);
  assert.equal(merged.state.board.empty, 3);
  assert.equal(merged.state.board.grids.find((grid) => grid.index === 1).itemId, "b2");
  assert.equal(merged.conservation.beforeUnits, merged.conservation.afterUnits);
  const submitted = simulateDeterministicTransition(merged.state, { type: "submit-order", slot: "o" });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.state.coins, 25);
  assert.equal(submitted.state.mapCoinDeficit, 5);
  assert.equal(submitted.state.orders.length, 0);
  assert.equal(submitted.state.board.empty, 4);
});

test("duplicate order requirements allocate distinct executable grids", () => {
  const input = fixture({ grids: [{ itemId: "b1" }, { itemId: "x1" }, { itemId: "x1" }], empty: 1, orderItem: "b1" });
  input.state.orders[0].items = [{ itemId: "b1", complete: true }, { itemId: "b1", complete: false }];
  input.state.board.requiredItemCounts = { b1: 2 };
  const normalized = normalizePlannerState(input);
  const merged = simulateDeterministicTransition(normalized, { type: "merge", from: 1, to: 2 });
  assert.equal(merged.ok, true);
  assert.equal(merged.state.orders[0].ready, false);
  assert.equal(merged.state.orders[0].items[1].complete, false);
  assert.equal(simulateDeterministicTransition(merged.state, { type: "submit-order", slot: "o" }).reason, "order-not-ready");
});

test("space planner merges to release a buffer before deterministic production and exposes only the first action", () => {
  const input = fixture({ grids: [{ itemId: "p", produceCount: 2, energyCost: 1 }, { itemId: "x1" }, { itemId: "x1" }, { itemId: "b1" }], empty: 0 });
  const result = planDeterministicOrder(normalizePlannerState(input), "o");
  assert.equal(result.status, "planned");
  assert.deepEqual(result.nextAction, { type: "merge", from: 1, to: 2, itemId: "x1", resultItemId: "x2" });
  assert.equal(result.boardSpaceFeasibility.feasible, true);
  assert.equal(result.boardSpaceFeasibility.peakOccupied, 4);
  assert.equal(result.explanation.selected, "merge releases board space before deterministic production");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "actions"), false);
});

test("unsafe candidates are filtered and a full board without a safe release reports deadlock", () => {
  const input = fixture({ grids: [{ itemId: "p", produceCount: 2, energyCost: 1 }, { itemId: "x1" }, { itemId: "x1" }, { itemId: "b1" }], empty: 0, frozen: true });
  input.state.board.grids[2].locked = true;
  const result = planDeterministicOrder(normalizePlannerState(input), "o");
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "board-space-deadlock");
  assert.ok(result.explanation.pruned["unsafe-merge"] > 0);
});

test("order reservations are hard constraints and are never consumed as space cleanup", () => {
  const input = fixture({ grids: [{ itemId: "p", produceCount: 2, energyCost: 1 }, { itemId: "x1" }, { itemId: "x1" }, { itemId: "b1" }], empty: 0 });
  input.state.board.requiredItemCounts.x1 = 1;
  const result = planDeterministicOrder(normalizePlannerState(input), "o");
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "board-space-deadlock");
  assert.ok(result.explanation.pruned["unsafe-merge"] > 0);
});

test("an unavailable duplicate cannot consume the reservation for executable supply", () => {
  const input = fixture({ grids: [{ itemId: "p", produceCount: 2, energyCost: 1 }, { itemId: "x1", frozen: true }, { itemId: "x1" }, { itemId: "x1" }, { itemId: "b1" }], empty: 0 });
  input.state.board.width = 5;
  input.state.board.requiredItemCounts.x1 = 1;
  const normalized = normalizePlannerState(input);
  assert.equal(normalized.board.grids[1].executable, false);
  assert.equal(normalized.board.grids.filter((grid) => grid.itemId === "x1" && grid.protected).length, 1);
  const result = planDeterministicOrder(normalized, "o");
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "board-space-deadlock");
});

test("a frozen exact-order item is not executable supply and never becomes a zero-step submission", () => {
  const input = fixture({ grids: [{ itemId: "b2", frozen: true }], empty: 3 });
  input.state.board.grids[0].frozen = true;
  const normalized = normalizePlannerState(input);
  const result = planDeterministicOrder(normalized, "o");
  assert.equal(normalized.board.grids[0].executable, false);
  assert.notEqual(result.nextAction?.type, "submit-order");
  assert.equal(result.status, "blocked");
});

test("insufficient live energy is an immediate hard planner boundary", () => {
  const input = fixture({ grids: [{ itemId: "p", produceCount: 2, energyCost: 1 }, { itemId: "b1" }], empty: 2, energy: 0 });
  const plan = buildOptimizationPlan(input);
  assert.equal(plan.recommended, null);
  assert.equal(plan.plans[0].blockingReason, "insufficient-energy");
  assert.equal(plan.boundaryReason, "insufficient-energy");
});

test("path comparison is lexicographic and cannot trade safety or space for coins", () => {
  const safe = { safe: true, boardSpaceFeasible: true, peakOccupied: 4, orderProgress: 0, mapProgressCoins: 0, opportunityLoss: 0, saleReturn: 0, actionCount: 4, tieBreaker: "b" };
  const unsafeRich = { ...safe, safe: false, mapProgressCoins: 1000, actionCount: 1 };
  const deadlockedRich = { ...safe, boardSpaceFeasible: false, mapProgressCoins: 1000, actionCount: 1 };
  const progress = { ...safe, orderProgress: 1, mapProgressCoins: 10, tieBreaker: "a" };
  assert.ok(comparePathScores(safe, unsafeRich) < 0);
  assert.ok(comparePathScores(safe, deadlockedRich) < 0);
  assert.ok(comparePathScores(progress, safe) < 0);
});

test("Item Opportunity Value keeps another order's demanded material when an equal space release exists", () => {
  const input = fixture({ grids: [{ itemId: "p", produceCount: 2, energyCost: 1 }, { itemId: "x1" }, { itemId: "x1" }, { itemId: "y1" }, { itemId: "y1" }, { itemId: "b1" }], empty: 0 });
  input.catalog.items.push(
    { id: "y1", chainId: "y", level: 1, baseUnits: 1, mergeTarget: "y2" },
    { id: "y2", chainId: "y", level: 2, baseUnits: 2, mergeTarget: null }
  );
  input.state.board.width = 6;
  input.state.orders.push({ slot: "future", rewardCoins: 5, ready: false, items: [{ itemId: "x1", complete: false }] });
  const result = planDeterministicOrder(normalizePlannerState(input), "o");
  assert.equal(result.status, "planned");
  assert.equal(result.nextAction.itemId, "y1");
  assert.equal(result.score.opportunityLoss, 0);
});

test("Item Opportunity Value saturates exact demand and permits merging true surplus copies", () => {
  const input = fixture({ grids: [{ itemId: "p", produceCount: 2, energyCost: 1 }, { itemId: "x1" }, { itemId: "x1" }, { itemId: "x1" }, { itemId: "y1" }, { itemId: "y1" }, { itemId: "b1" }], empty: 0 });
  input.catalog.items.push(
    { id: "y1", chainId: "y", level: 1, baseUnits: 1, mergeTarget: "y2" },
    { id: "y2", chainId: "y", level: 2, baseUnits: 2, mergeTarget: null }
  );
  input.state.board.width = 7;
  input.state.board.requiredItemCounts.x1 = 1;
  input.state.orders.push({ slot: "future", rewardCoins: 5, ready: false, items: [{ itemId: "x1", complete: false }] });
  const result = planDeterministicOrder(normalizePlannerState(input), "o");
  assert.equal(result.status, "planned");
  assert.equal(result.nextAction.itemId, "x1");
  assert.equal(result.score.opportunityLoss, 0);
});

test("small deterministic merge fixtures preserve units and never create negative capacity", () => {
  for (let pairs = 1; pairs <= 6; pairs += 1) {
    const grids = Array.from({ length: pairs * 2 }, () => ({ itemId: "b1" }));
    const normalized = normalizePlannerState(fixture({ grids, empty: 0 }));
    for (let pair = 0; pair < pairs; pair += 1) {
      const result = simulateDeterministicTransition(normalized, { type: "merge", from: pair * 2, to: pair * 2 + 1 });
      assert.equal(result.ok, true);
      assert.equal(result.conservation.beforeUnits, result.conservation.afterUnits);
      assert.ok(result.state.board.empty >= 0);
      assert.ok(result.state.board.occupied <= result.state.board.capacity);
    }
  }
});

test("order optimizer exposes the deterministic first action, space judgment, and pruning explanation", () => {
  const input = fixture({ grids: [{ itemId: "p", produceCount: 2, energyCost: 1 }, { itemId: "x1" }, { itemId: "x1" }, { itemId: "b1" }], empty: 0 });
  const plan = buildOptimizationPlan(input);
  assert.equal(plan.recommended.slot, "o");
  assert.equal(plan.recommended.nextAction.type, "merge");
  assert.equal(plan.recommended.boardSpaceFeasibility.feasible, true);
  assert.match(plan.recommended.explanation.selected, /releases board space/);
  assert.ok(plan.recommended.explanation.consideredStates > 1);
});

test("deterministic search stays responsive while warehouse storage still requires native preflight", async () => {
  const input = fixture({ grids: [], empty: 1 });
  input.catalog.items = input.catalog.items.filter((item) => ["p", "b1", "b2"].includes(item.id));
  input.state.board.grids = [];
  for (let chain = 0; chain < 10; chain += 1) {
    input.catalog.items.push(
      { id: `x${chain}-1`, chainId: `x${chain}`, level: 1, baseUnits: 1, mergeTarget: `x${chain}-2` },
      { id: `x${chain}-2`, chainId: `x${chain}`, level: 2, baseUnits: 2, mergeTarget: null },
    );
    input.state.board.grids.push(
      { index: input.state.board.grids.length, itemId: `x${chain}-1`, normal: true, moveable: true },
      { index: input.state.board.grids.length + 1, itemId: `x${chain}-1`, normal: true, moveable: true },
    );
  }
  input.state.board.grids.push(
    { index: input.state.board.grids.length, itemId: "p", normal: true, moveable: true, produceCount: 2, energyCost: 1 },
    { index: input.state.board.grids.length + 1, itemId: "b1", normal: true, moveable: true },
  );
  input.state.board.width = 23;
  input.state.board.height = 1;
  input.state.board.occupied = input.state.board.grids.length;
  input.state.board.empty = 1;
  input.state.warehouse = { loaded: false, occupiedSlots: 0, totalSlots: 0 };

  const plannerPath = path.resolve(__dirname, "..", "src", "space-planner.js");
  const source = `
    const { normalizePlannerState, planDeterministicOrder } = require(${JSON.stringify(plannerPath)});
    const input = ${JSON.stringify(input)};
    const result = planDeterministicOrder(normalizePlannerState(input), "o");
    process.stdout.write(JSON.stringify({ status: result.status, consideredStates: result.explanation.consideredStates }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["-e", source], { timeout: 4000, windowsHide: true });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "planned");
  assert.ok(result.consideredStates > 1);
});
