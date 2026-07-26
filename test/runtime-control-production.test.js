

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationRuntime } = require("../src/automation-runtime");
const {
  CdpRuntimeControlAdapter,
  FakeRuntimeControlAdapter,
} = require("../src/runtime-control-bridge");

function normalizedBaseline() {
  return {
    schemaVersion: 1,
    collectedAt: "2026-07-23T00:00:00.000Z",
    scene: "board",
    resources: { coins: 0, diamonds: 0, energy: 10 },
    energy: {
      amount: 10,
      limit: 20,
      recoverIntervalSeconds: 60,
      recoverTimestamp: 1234,
      recovering: true,
    },
    board: {
      available: true,
      visible: true,
      width: 2,
      height: 2,
      occupied: 1,
      empty: 3,
      signature: "producer-1|||",
      grids: [
        { index: 0, itemId: "producer-1", empty: false, normal: true, moveable: true, actionReady: true,
          produceCount: 5, energyCost: 1, currentProductionModeId: "single",
          availableProductionModes: [{ modeId: "single", unlocked: true }],
          productionModeSwitchEntry: { status: "unavailable", method: null },
        },
        { index: 1, itemId: "", empty: true },
        { index: 2, itemId: "", empty: true },
        { index: 3, itemId: "", empty: true },
      ],
      mergeCandidates: [],
      requiredItemCounts: {},
    },
    orders: [],
    producers: [{ index: 0, itemId: "producer-1", produceCount: 5, energyCost: 1 }],
    warehouse: { inventoryKnowledge: { status: "unknown" } },
    mapProgress: {
      currentTask: null,
      currentSeason: null,
      seasonDisplay: null,
      allFinished: false,
      episodeFinished: false,
    },
    mapMission: null,
    overlays: [],
    selectedItem: null,
    source: { adapter: "semantic-runtime", engine: "cocos" },
  };
}

function producerRuntime(options = {}) {
  const emptyBoard = options.emptyBoard !== false;
  const touchedOutputItemIds = options.touchedOutputItemIds || ["item-1"];
  const produceCount = options.produceCount ?? 5;
  const energyCost = options.energyCost ?? 1;
  const energyAmount = options.energyAmount ?? 10;
  const modeId = options.modeId ?? "single";
  const availableModes = options.availableModes || [{ modeId: "single", unlocked: true }];
  const touchRequiresTwoCalls = options.touchRequiresTwoCalls !== false;
  const throwOnTouch = options.throwOnTouch || false;
  const boardSize = options.boardSize || { width: 2, height: 2 };

  let touchCount = 0;
  const selectedBeforeTouch = null;

  const producerConfig = {
    Level: 1,
    EnergyCost: energyCost,
    Price: 0,
    CreateData: touchedOutputItemIds,
    Version: "1",
  };
  const producerGrid = {
    index: 0,
    itemId: "producer-1",
    item: {
      itemConfig: producerConfig,
      produceCount,
      taskNeed: false,
    },
    isEmpty: false,
    isNormal: true,
    isMoveable: true,
    isLocking: false,
    isFrozen: false,
    center: { x: 50, y: 50 },
  };
  const outputGrids = emptyBoard
    ? touchedOutputItemIds.map((_itemId, i) => ({
        index: i + 1,
        itemId: "",
        item: null,
        isEmpty: true,
        isNormal: false,
        isMoveable: false,
        isLocking: false,
        isFrozen: false,
        center: { x: 50 + (i + 1) * 100, y: 50 },
      }))
    : [];
  const allGrids = [producerGrid, ...outputGrids];
  while (allGrids.length < boardSize.width * boardSize.height) {
    const idx = allGrids.length;
    allGrids.push({
      index: idx,
      itemId: "",
      item: null,
      isEmpty: true,
      isNormal: false,
      isMoveable: false,
      isLocking: false,
      isFrozen: false,
      center: { x: 50 + idx * 100, y: 50 },
    });
  }

  const gameBoard = { size: boardSize, __private_95_grids: allGrids };

  const boardView = {
    _boardStore: { _state: { _gameBoard: gameBoard } },
    _touchHandler: {
      currentSelectedBoardGrid: null,
    },
    canBoardGridBeDragging: () => true,
    isBoardGridItemAnimating: () => false,
    onTouch: (_center) => {
      if (throwOnTouch) throw new Error("touch failed during animation");
      touchCount += 1;
      if (touchRequiresTwoCalls && touchCount === 1) {
        return;
      }
      // Produce items (clear producer count; fill empty grids)
      if (producerGrid.item && producerGrid.item.produceCount > 0) {
        producerGrid.item.produceCount -= 1;
      }
      for (const outputGrid of outputGrids) {
        const idx = outputGrids.indexOf(outputGrid);
        if (idx < touchedOutputItemIds.length) {
          outputGrid.itemId = touchedOutputItemIds[idx];
          outputGrid.item = {
            itemConfig: { Level: 1, MergeTarget: null, EnergyCost: 0, Price: 1 },
            produceCount: 0,
            taskNeed: false,
          };
          outputGrid.isEmpty = false;
          outputGrid.isNormal = true;
          outputGrid.isMoveable = true;
        }
      }
    },
  };

  const boardController = {
    _controllerClazzName: "UserBoardViewController",
    isViewVisible: true,
    view: { _boardView: { _gameBoardView: boardView } },
  };

  const multipleModeMap = new Map();
  multipleModeMap.set("producer-1", { modeId });
  const multipleModeManager = {
    _multipleModeMap: multipleModeMap,
    _isOpenedFourfoldMode: availableModes.some((m) => m.modeId === "quad"),
    setMultipleMode: (itemId, newModeId) => {
      multipleModeMap.set(String(itemId), { modeId: String(newModeId) });
    },
  };

  const resourceMap = new Map([
    [1, 0],
    [2, 0],
    [3, energyAmount],
  ]);
  const energyDataMap = new Map([
    [3, { _energyLimit: 20, _recoverInterval: 60, recoverTimestamp: 1234, inRecover: true }],
  ]);

  return {
    boardController,
    boardView,
    producerGrid,
    outputGrids,
    allGrids,
    touchCount: () => touchCount,
    selectedBeforeTouch: () => selectedBeforeTouch,
    setEnergy: (amount) => { resourceMap.set(3, amount); },
    setProduceCount: (count) => { producerGrid.item.produceCount = count; },
    runtime: {
      mControllers: [boardController],
      mManagers: [
        { _resourceMap: resourceMap },
        { _energyDataMap: energyDataMap },
        { clientTaskDataMap: new Map() },
        multipleModeManager,
      ],
    },
  };
}

function createAdapter(options = {}) {
  const live = producerRuntime(options);
  const scene = {
    name: "main",
    getChildByName: (name) => name === "Entry" ? { _components: [live.runtime] } : null,
    children: [],
  };
  const context = vm.createContext({
    globalThis: null,
    cc: {
      ENGINE_VERSION: "3.8.0",
      director: { getScene: () => scene },
    },
  });
  context.globalThis = context;
  const evaluations = [];
  let legacyExecutions = 0;
  let legacyReads = 0;
  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression, contextId) => {
        evaluations.push({ expression, contextId });
        return vm.runInContext(expression, context);
      },
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp", contextId: 7 }),
      readState: async () => {
        legacyReads += 1;
        return normalizedBaseline();
      },
      execute: async () => {
        legacyExecutions += 1;
        return { ok: true, reason: "legacy-action" };
      },
    },
  });
  return {
    adapter,
    context,
    evaluations,
    live,
    legacyExecutions: () => legacyExecutions,
    legacyReads: () => legacyReads,
  };
}

// ── Capability detection ──────────────────────────────────────────────────────

test("CDP Adapter detects production capability when producer touch handler exists", async () => {
  const fixture = createAdapter();
  const readiness = await fixture.adapter.ready();

  assert.equal(readiness.capabilities.production, true);
  assert.equal(readiness.capabilities.baseline, true);
  assert.equal(readiness.capabilities.boardRead, true);
  assert.equal(readiness.capabilities.merge, false);
  assert.equal(fixture.legacyExecutions(), 0);
});

test("CDP Adapter detects production capability when onTouch is missing", async () => {
  const fixture = createAdapter();
  delete fixture.live.boardView.onTouch;

  const readiness = await fixture.adapter.ready();

  assert.equal(readiness.capabilities.baseline, true);
  assert.equal(readiness.capabilities.production, false);
});

// ── Success: stochastic production returns actual item identities ─────────────

test("semantic production executes one touch and returns actual produced item identities", async () => {
  const fixture = createAdapter({ touchRequiresTwoCalls: false });
  await fixture.adapter.ready();

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 0,
    plannedAction: {
      type: "produce",
      producer: 0,
      producerItemId: "producer-1",
      productionModeId: "single",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(result.stopReason, "max_actions_reached");
  assert.deepEqual(result.actions[0].type, "produce");
  assert.equal(result.actions[0].producer, 0);
  assert.equal(result.actions[0].producerItemId, "producer-1");
  assert.deepEqual(result.actions[0].actualOutputItemIds, ["item-1"]);
  assert.equal(result.actions[0].verified, true);
  assert.equal(result.acknowledgement.outcome, "accepted-changed");
  assert.equal(result.acknowledgement.method, "production");
  assert.equal(result.acknowledgement.revision, 1);
  assert.ok(Array.isArray(result.acknowledgement.delta.producedItemIds));
  assert.deepEqual(result.acknowledgement.delta.producedItemIds, ["item-1"]);
  assert.equal(result.acknowledgement.delta.energyChange, -1);
  assert.ok(Array.isArray(result.acknowledgement.delta.board.grids));
  assert.equal(fixture.legacyExecutions(), 0);
});

test("baseline reads preserve the runtime revision for the next semantic production", async () => {
  const fixture = createAdapter({ touchRequiresTwoCalls: false });
  await fixture.adapter.ready();

  const first = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 0,
    plannedAction: {
      type: "produce",
      producer: 0,
      productionModeId: "single",
    },
  });
  assert.equal(first.ok, true);
  assert.equal(first.acknowledgement.revision, 1);

  await fixture.adapter.readState();

  assert.equal(fixture.adapter.status().revision, 1);
  const second = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 0,
    plannedAction: {
      type: "produce",
      producer: 0,
      productionModeId: "single",
    },
  });
  assert.equal(second.reason, "production-unchanged");
  assert.equal(second.acknowledgement.expectedRevision, 1);
  assert.equal(second.acknowledgement.outcome, "accepted-unchanged");
});

// ── Two-touch activation ─────────────────────────────────────────────────────

test("semantic production uses two touches when first touch selects the producer", async () => {
  const fixture = createAdapter({ touchRequiresTwoCalls: true });
  await fixture.adapter.ready();

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 0,
    plannedAction: {
      type: "produce",
      producer: 0,
      productionModeId: "single",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(fixture.live.touchCount(), 2);
  assert.equal(result.actions[0].touches, 2);
  assert.equal(result.actions[0].verified, true);
  assert.deepEqual(result.actions[0].actualOutputItemIds, ["item-1"]);
});

// ── Multiple stochastic outcomes ─────────────────────────────────────────────

test("semantic production reports multiple output item identities from a multi-output mode", async () => {
  const fixture = createAdapter({
    touchRequiresTwoCalls: false,
    touchedOutputItemIds: ["item-1", "item-2", "item-3"],
    modeId: "triple",
    availableModes: [{ modeId: "single", unlocked: true }, { modeId: "triple", unlocked: true }],
    boardSize: { width: 3, height: 2 },
  });
  await fixture.adapter.ready();

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 0,
    plannedAction: {
      type: "produce",
      producer: 0,
      productionModeId: "triple",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.deepEqual(result.actions[0].actualOutputItemIds, ["item-1", "item-2", "item-3"]);
  assert.equal(result.acknowledgement.outcome, "accepted-changed");
  assert.deepEqual(result.acknowledgement.delta.producedItemIds, ["item-1", "item-2", "item-3"]);
});

// ── Stale revision ───────────────────────────────────────────────────────────

test("semantic production rejects a stale expected revision without mutating the board", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 0,
    operationId: "stale-production",
    expectedRevision: 5,
    plannedAction: {
      type: "produce",
      producer: 0,
      productionModeId: "single",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "runtime-revision-stale");
  assert.equal(result.acknowledgement.outcome, "stale-revision");
  assert.equal(result.replanRequested, true);
  assert.equal(fixture.live.touchCount(), 0);
  assert.equal(fixture.live.producerGrid.item.produceCount, 5);
});

// ── Duplicate operation idempotency ──────────────────────────────────────────

test("semantic production retries return the cached acknowledgement without repeating the mutation", async () => {
  const fixture = createAdapter({ touchRequiresTwoCalls: false });
  await fixture.adapter.ready();
  const command = {
    type: "run-board-action",
    producer: 0,
    operationId: "production-operation-1",
    plannedAction: {
      type: "produce",
      producer: 0,
      productionModeId: "single",
    },
  };

  const first = await fixture.adapter.execute(command);
  const duplicate = await fixture.adapter.execute(command);

  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.deepEqual(duplicate.acknowledgement, first.acknowledgement);
  assert.equal(fixture.live.touchCount(), 1);
  assert.equal(fixture.legacyExecutions(), 0);
});

// ── Production mode mismatch ─────────────────────────────────────────────────

test("semantic production rejects when the current Production Mode does not match", async () => {
  const fixture = createAdapter({ modeId: "double" });
  await fixture.adapter.ready();

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 0,
    plannedAction: {
      type: "produce",
      producer: 0,
      productionModeId: "single",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "production-mode-mismatch");
  assert.equal(result.acknowledgement.outcome, "rejected-precondition");
  assert.equal(fixture.live.touchCount(), 0);
});

test("semantic production succeeds when current Production Mode matches the expected mode", async () => {
  const fixture = createAdapter({
    touchRequiresTwoCalls: false,
    modeId: "double",
    touchedOutputItemIds: ["item-1", "item-2"],
    boardSize: { width: 2, height: 2 },
  });
  await fixture.adapter.ready();

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 0,
    plannedAction: {
      type: "produce",
      producer: 0,
      productionModeId: "double",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.deepEqual(result.actions[0].actualOutputItemIds, ["item-1", "item-2"]);
  assert.equal(result.acknowledgement.delta.energyChange, -1);
});

// ── Insufficient energy ──────────────────────────────────────────────────────

test("semantic production rejects when energy is insufficient", async () => {
  const fixture = createAdapter({ energyAmount: 0 });
  await fixture.adapter.ready();

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 0,
    plannedAction: {
      type: "produce",
      producer: 0,
      productionModeId: "single",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "energy-insufficient");
  assert.equal(result.acknowledgement.outcome, "rejected-precondition");
  assert.equal(fixture.live.touchCount(), 0);
});

// ── Full board ───────────────────────────────────────────────────────────────

test("semantic production rejects when the board is full", async () => {
  const fixture = createAdapter({ boardSize: { width: 1, height: 2 }, touchedOutputItemIds: [], emptyBoard: false });
  // Pre-fill the only non-producer grid so empty count is 0
  fixture.live.allGrids[1].itemId = "blocker";
  fixture.live.allGrids[1].isEmpty = false;
  await fixture.adapter.ready();

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 0,
    plannedAction: {
      type: "produce",
      producer: 0,
      productionModeId: "single",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "board-full");
  assert.equal(result.acknowledgement.outcome, "rejected-precondition");
});

// ── Unchanged outcome ────────────────────────────────────────────────────────

test("semantic production reports unchanged when board state does not change", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();
  // Don't let onTouch change the board
  fixture.live.boardView.onTouch = () => {};

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 0,
    plannedAction: {
      type: "produce",
      producer: 0,
      productionModeId: "single",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.executed, true);
  assert.equal(result.reason, "production-unchanged");
  assert.equal(result.acknowledgement.outcome, "accepted-unchanged");
});

// ── Producer exhausted (no produce count) ────────────────────────────────────

test("semantic production rejects when producer has no remaining produce count", async () => {
  const fixture = createAdapter({ produceCount: 0 });
  await fixture.adapter.ready();

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 0,
    plannedAction: {
      type: "produce",
      producer: 0,
      productionModeId: "single",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "producer-exhausted");
  assert.equal(result.acknowledgement.outcome, "rejected-precondition");
  assert.equal(fixture.live.touchCount(), 0);
});

// ── Uncertainty from production error ────────────────────────────────────────

test("an uncertain production result escalates to targeted board verification and preserves pause", async () => {
  const fixture = createAdapter({ throwOnTouch: true });
  await fixture.adapter.ready();

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 0,
    operationId: "uncertain-production",
    plannedAction: {
      type: "produce",
      producer: 0,
      productionModeId: "single",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.executed, true);
  assert.equal(result.reason, "production-result-uncertain");
  assert.equal(result.pauseRequested, true);
  assert.equal(result.acknowledgement.outcome, "uncertain-result");
  assert.ok(result.targetedVerification);
});

// ── Producer not found ───────────────────────────────────────────────────────

test("semantic production rejects when the producer grid is not a valid producer", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 99,
    plannedAction: {
      type: "produce",
      producer: 99,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "producer-not-found");
  assert.equal(result.acknowledgement.outcome, "rejected-precondition");
});

// ── Board not visible ───────────────────────────────────────────────────────

test("semantic production rejects when the board is not visible", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();
  fixture.live.boardController.isViewVisible = false;

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 0,
    plannedAction: {
      type: "produce",
      producer: 0,
      productionModeId: "single",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "board-not-visible");
  assert.equal(result.acknowledgement.outcome, "rejected-precondition");
});

// ── Fallback to legacy when production capability is missing ─────────────────

test("missing production capability leaves the Legacy Adapter available for the command", async () => {
  const fixture = createAdapter();
  delete fixture.live.boardView.onTouch;

  const readiness = await fixture.adapter.ready();
  assert.equal(readiness.capabilities.production, false);

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    producer: 0,
    plannedAction: {
      type: "produce",
      producer: 0,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "legacy-action");
  assert.equal(fixture.legacyExecutions(), 1);
});

// ── End-to-end scenario with Fake Adapter ─────────────────────────────────────

test("Automation Runtime records actual produced item identities from a semantic production", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-production-e2e-"));
  const catalog = {
    rules: {},
    coverage: { completeChains: ["items", "producer"], incompleteChains: [] },
    chains: [
      { id: "items", complete: true, minLevel: 1, maxLevel: 1, itemIds: ["item-1"] },
      { id: "producer", complete: true, minLevel: 1, maxLevel: 1, itemIds: ["producer-1"] },
    ],
    items: [
      { id: "item-1", chainId: "items", level: 1, baseUnits: 1, mergeTarget: null },
      { id: "producer-1", chainId: "producer", level: 1, baseUnits: 1, mergeTarget: null },
    ],
    producers: [{
      itemId: "producer-1",
      chainId: "producer",
      level: 1,
      energyCost: 1,
      sampleSize: 1,
      drops: [{ itemId: "item-1", count: 1, probability: 1 }],
    }],
  };
  fs.writeFileSync(path.join(dataDir, "item-catalog.json"), JSON.stringify(catalog), "utf8");

  function boardState({ ready = false, energy = 5 } = {}) {
    return {
      schemaVersion: 1,
      collectedAt: new Date().toISOString(),
      scene: "board",
      resources: { coins: 0, diamonds: 0, energy },
      energy: { amount: energy, limit: 10, recoverIntervalSeconds: 60, recoverTimestamp: null, recovering: false },
      board: {
        available: true,
        visible: true,
        width: 2,
        height: 2,
        occupied: ready ? 2 : 1,
        empty: ready ? 2 : 3,
        signature: ready ? "producer-1|item-1" : "producer-1",
        grids: [
          { index: 0, itemId: "producer-1", normal: true, moveable: true, frozen: false, locked: false, produceCount: 5, energyCost: 1 },
          ...(ready ? [{ index: 1, itemId: "item-1", normal: true, moveable: true, frozen: false, locked: false }] : []),
        ],
        mergeCandidates: [],
        requiredItemCounts: ready ? {} : { "item-1": 1 },
      },
      orders: [{
        slot: "order-1",
        rewardCoins: 10,
        ready,
        items: [{ itemId: "item-1", complete: ready, status: ready ? 1 : 0 }],
        requiredItemIds: ["item-1"],
        missingItemIds: ready ? [] : ["item-1"],
      }],
      producers: [{ index: 0, itemId: "producer-1", produceCount: 5, energyCost: 1 }],
      warehouse: { inventoryKnowledge: { status: "unknown" } },
      mapMission: { canComplete: false },
      mapProgress: { currentTask: null, currentSeason: null, seasonDisplay: null, allFinished: false, episodeFinished: false },
      overlays: [],
      selectedItem: null,
      source: { adapter: "fake" },
    };
  }

  const stateBefore = boardState({ ready: false, energy: 5 });
  const stateAfter = boardState({ ready: true, energy: 4 });

  const runtimeControl = new FakeRuntimeControlAdapter({
    states: [stateBefore, stateAfter],
    results: [
      {
        ok: true,
        executed: true,
        reason: "production-complete",
        stopReason: "order_ready",
        actions: [{
          step: 1,
          type: "produce",
          producer: 0,
          producerItemId: "producer-1",
          productionModeId: "single",
          actualOutputItemIds: ["item-1"],
          touches: 1,
          emptyBefore: 3,
          emptyAfter: 2,
          verified: true,
        }],
        acknowledgement: {
          outcome: "accepted-changed",
          reason: "production-complete",
          revision: 1,
          delta: {
            energyChange: -1,
            producedItemIds: ["item-1"],
            board: { grids: [{ index: 1, itemId: "item-1", empty: false }] },
          },
        },
      },
      {
        ok: true,
        reason: "order-submitted-and-coins-received",
        coinsBefore: 0,
        coinsAfter: 10,
      },
    ],
  });
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
    runtimeControl,
  });

  try {
    const result = await runtime.start({ mode: "automatic", maxActions: 2 });

    assert.equal(result.reason, "order-completed");
    assert.deepEqual(runtimeControl.commands.map((c) => c.type), ["run-board-action", "submit-order"]);
    assert.equal(runtimeControl.readCount, 2);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
