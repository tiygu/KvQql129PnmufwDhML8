

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
const { OrderCoinLoop } = require("../src/order-coin-loop");

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
      height: 1,
      occupied: 2,
      empty: 0,
      signature: "item-1|item-1",
      grids: [
        { index: 0, itemId: "item-1", empty: false, normal: true, moveable: true, actionReady: true, mergeTarget: "item-2" },
        { index: 1, itemId: "item-1", empty: false, normal: true, moveable: true, actionReady: true, mergeTarget: "item-2" },
      ],
      mergeCandidates: [{ from: 0, to: 1, itemId: "item-1", mergeTarget: "item-2" }],
      requiredItemCounts: {},
    },
    orders: [],
    producers: [],
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

function mergeRuntime() {
  let mergeExecutions = 0;
  const itemConfig = { Level: 1, MergeTarget: "item-2", EnergyCost: 0, Price: 1 };
  const source = {
    index: 0,
    itemId: "item-1",
    item: { itemConfig },
    isEmpty: false,
    isNormal: true,
    isMoveable: true,
    isLocking: false,
    isFrozen: false,
    center: { x: 0, y: 0 },
  };
  const target = {
    index: 1,
    itemId: "item-1",
    item: { itemConfig },
    isEmpty: false,
    isNormal: true,
    isMoveable: true,
    isLocking: false,
    isFrozen: false,
    center: { x: 1, y: 0 },
  };
  const gameBoard = {
    size: { width: 2, height: 1 },
    __private_95_grids: [source, target],
  };
  const boardView = {
    _boardStore: { _state: { _gameBoard: gameBoard } },
    _operatorCenter: {
      itemCanMergeWith: (left, right) => left?.itemConfig?.MergeTarget === "item-2"
        && right?.itemConfig?.MergeTarget === "item-2",
    },
    _dragHandler: { predictDragResult: () => "item-2" },
    canBoardGridBeDragging: () => true,
    isBoardGridItemAnimating: () => false,
    onDragStart: () => {},
    onDragMove: () => {},
    onDragEnd: async () => {
      mergeExecutions += 1;
      source.itemId = "";
      source.item = null;
      source.isEmpty = true;
      target.itemId = "item-2";
      target.item = {
        itemConfig: { Level: 2, MergeTarget: "item-3", EnergyCost: 0, Price: 2 },
      };
    },
  };
  const boardController = {
    _controllerClazzName: "UserBoardViewController",
    isViewVisible: true,
    view: { _boardView: { _gameBoardView: boardView } },
  };
  return {
    boardController,
    boardView,
    mergeExecutions: () => mergeExecutions,
    source,
    target,
    runtime: {
      mControllers: [boardController],
      mManagers: [
        { _resourceMap: new Map([[1, 0], [2, 0], [3, 10]]) },
        { _energyDataMap: new Map([[3, { _energyLimit: 20, _recoverInterval: 60, recoverTimestamp: 1234, inRecover: true }]]) },
        { clientTaskDataMap: new Map() },
      ],
    },
  };
}

function createAdapter() {
  const live = mergeRuntime();
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

test("CDP Adapter executes an invariant-complete merge through the semantic bridge", async () => {
  const fixture = createAdapter();
  const readiness = await fixture.adapter.ready();

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    merge: { from: 0, to: 1 },
    plannedAction: {
      type: "merge",
      from: 0,
      to: 1,
      itemId: "item-1",
      resultItemId: "item-2",
    },
  });

  assert.equal(readiness.capabilities.merge, true);
  assert.equal(readiness.bridgeVersion, "1.2.0");
  assert.equal(fixture.legacyExecutions(), 0);
  assert.equal(fixture.evaluations.length, 2);
  assert.match(fixture.evaluations[1].expression, /^globalThis\.miniGameCtl\.executeCommand\(/);
  assert.doesNotMatch(fixture.evaluations[1].expression, /mControllers|UserBoardViewController/);
  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(result.stopReason, "max_actions_reached");
  assert.deepEqual(result.actions, [{
    step: 1,
    type: "merge",
    from: 0,
    to: 1,
    itemId: "item-1",
    expectedTarget: "item-2",
    actualTarget: "item-2",
    verified: true,
  }]);
  assert.match(result.acknowledgement.operationId, /^merge-/);
  assert.equal(result.acknowledgement.expectedRevision, 0);
  assert.equal(result.acknowledgement.revision, 1);
  assert.equal(result.acknowledgement.outcome, "accepted-changed");
  assert.equal(result.acknowledgement.reason, "merge-complete");
  assert.deepEqual(result.acknowledgement.delta.board.grids, [
    { index: 0, itemId: "", empty: true },
    { index: 1, itemId: "item-2", empty: false },
  ]);
  assert.equal(fixture.adapter.status().revision, 1);
});

test("semantic merge retries return the cached acknowledgement without repeating the mutation", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();
  const command = {
    type: "run-board-action",
    operationId: "merge-operation-1",
    expectedRevision: 0,
    merge: {
      type: "merge",
      from: 0,
      to: 1,
      itemId: "item-1",
      expectedTarget: "item-2",
    },
  };

  const first = await fixture.adapter.execute(command);
  const duplicate = await fixture.adapter.execute(command);

  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.deepEqual(duplicate.acknowledgement, first.acknowledgement);
  assert.equal(fixture.live.mergeExecutions(), 1);
  assert.equal(fixture.legacyExecutions(), 0);
});

test("semantic merge rejects a stale expected revision without mutating the board", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    operationId: "stale-merge",
    expectedRevision: 4,
    merge: { from: 0, to: 1, itemId: "item-1", expectedTarget: "item-2" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "runtime-revision-stale");
  assert.equal(result.acknowledgement.outcome, "stale-revision");
  assert.equal(result.acknowledgement.revision, 0);
  assert.equal(result.replanRequested, true);
  assert.equal(result.replanState.board.signature, "item-1|item-1");
  assert.equal(fixture.evaluations.at(-1).expression, "globalThis.miniGameCtl.readBaseline()");
  assert.equal(fixture.live.mergeExecutions(), 0);
  assert.equal(fixture.live.source.itemId, "item-1");
  assert.equal(fixture.live.target.itemId, "item-1");
});

test("semantic merge rejects changed items and a rejected live merge relation", async (t) => {
  await t.test("changed items", async () => {
    const fixture = createAdapter();
    await fixture.adapter.ready();
    fixture.live.source.itemId = "item-other";

    const result = await fixture.adapter.execute({
      type: "run-board-action",
      operationId: "changed-item-merge",
      merge: { from: 0, to: 1, itemId: "item-1", expectedTarget: "item-2" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "merge-items-changed");
    assert.equal(result.acknowledgement.outcome, "rejected-precondition");
    assert.equal(fixture.live.mergeExecutions(), 0);
  });

  await t.test("live relation rejection", async () => {
    const fixture = createAdapter();
    await fixture.adapter.ready();
    fixture.live.boardView._operatorCenter.itemCanMergeWith = () => false;

    const result = await fixture.adapter.execute({
      type: "run-board-action",
      operationId: "rejected-relation-merge",
      merge: { from: 0, to: 1, itemId: "item-1", expectedTarget: "item-2" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "merge-pair-rejected");
    assert.equal(result.acknowledgement.outcome, "rejected-precondition");
    assert.equal(fixture.live.mergeExecutions(), 0);
  });
});

test("semantic merge reports an accepted command that left the board unchanged", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();
  fixture.live.boardView.onDragEnd = async () => {};

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    operationId: "unchanged-merge",
    merge: { from: 0, to: 1, itemId: "item-1", expectedTarget: "item-2" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.executed, true);
  assert.equal(result.reason, "merge-unchanged");
  assert.equal(result.acknowledgement.outcome, "accepted-unchanged");
  assert.equal(result.acknowledgement.revision, 0);
  assert.equal(fixture.legacyExecutions(), 0);
});

test("an uncertain semantic merge escalates to targeted board verification and preserves pause semantics", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();
  fixture.live.boardView.onDragEnd = async () => {
    fixture.live.source.itemId = "";
    fixture.live.source.item = null;
    fixture.live.source.isEmpty = true;
    throw new Error("drag completion signal was lost");
  };

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    operationId: "uncertain-merge",
    merge: { from: 0, to: 1, itemId: "item-1", expectedTarget: "item-2" },
  });

  assert.equal(fixture.evaluations.length, 3);
  assert.equal(fixture.evaluations[2].expression, "globalThis.miniGameCtl.readBoard()");
  assert.equal(result.ok, false);
  assert.equal(result.executed, true);
  assert.equal(result.reason, "merge-result-uncertain");
  assert.equal(result.pauseRequested, true);
  assert.equal(result.acknowledgement.outcome, "uncertain-result");
  assert.equal(result.acknowledgement.revision, 1);
  assert.deepEqual(result.targetedVerification.grids, [
    { index: 0, itemId: "", empty: true },
    { index: 1, itemId: "item-1", empty: false },
  ]);
  assert.equal(fixture.legacyExecutions(), 0);
});

test("the replan state read after semantic merge stays on the bounded bridge baseline", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();
  await fixture.adapter.execute({
    type: "run-board-action",
    operationId: "merge-before-replan",
    merge: { from: 0, to: 1, itemId: "item-1", expectedTarget: "item-2" },
  });

  const replanningState = await fixture.adapter.readState();

  assert.equal(fixture.legacyReads(), 1);
  assert.equal(fixture.evaluations.length, 3);
  assert.equal(fixture.evaluations[2].expression, "globalThis.miniGameCtl.readBaseline()");
  assert.equal(replanningState.board.signature, "|item-2");
  assert.equal(replanningState.board.occupied, 1);
  assert.equal(replanningState.board.empty, 1);
});

test("the injected command contract reports unsupported methods with a stable outcome", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();

  const acknowledgement = await vm.runInContext(
    `globalThis.miniGameCtl.executeCommand({
      operationId: "unsupported-command",
      expectedRevision: 0,
      method: "production",
      sourceGrid: 0,
      targetGrid: 1
    })`,
    fixture.context,
  );

  assert.deepEqual(JSON.parse(JSON.stringify(acknowledgement)), {
    ok: false,
    outcome: "unsupported-capability",
    reason: "production-unsupported",
    operationId: "unsupported-command",
    method: "production",
    expectedRevision: 0,
    revision: 0,
    changed: false,
  });
  assert.equal(fixture.live.mergeExecutions(), 0);
});

test("semantic merge addresses grids by their normalized grid index rather than array position", async () => {
  const fixture = createAdapter();
  fixture.live.source.index = 10;
  fixture.live.target.index = 12;
  await fixture.adapter.ready();

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    operationId: "non-positional-grid-merge",
    merge: { from: 10, to: 12, itemId: "item-1", expectedTarget: "item-2" },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.actions[0], {
    step: 1,
    type: "merge",
    from: 10,
    to: 12,
    itemId: "item-1",
    expectedTarget: "item-2",
    actualTarget: "item-2",
    verified: true,
  });
  assert.deepEqual(result.acknowledgement.delta.board.grids, [
    { index: 10, itemId: "", empty: true },
    { index: 12, itemId: "item-2", empty: false },
  ]);
});

test("missing merge-readiness support leaves the Legacy Adapter available for the command", async () => {
  const fixture = createAdapter();
  delete fixture.live.boardView.canBoardGridBeDragging;

  const readiness = await fixture.adapter.ready();
  const result = await fixture.adapter.execute({
    type: "run-board-action",
    merge: { from: 0, to: 1, itemId: "item-1", expectedTarget: "item-2" },
  });

  assert.equal(readiness.capabilities.merge, false);
  assert.deepEqual(result, { ok: true, reason: "legacy-action" });
  assert.equal(fixture.legacyExecutions(), 1);
  assert.equal(fixture.live.mergeExecutions(), 0);
});

test("a lost merge acknowledgement retries the same operation ID without repeating the mutation", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();
  const evaluate = fixture.adapter.client.evaluate.bind(fixture.adapter.client);
  let loseFirstAcknowledgement = true;
  fixture.adapter.client.evaluate = async (expression, contextId, options) => {
    if (expression.startsWith("globalThis.miniGameCtl.executeCommand(") && loseFirstAcknowledgement) {
      loseFirstAcknowledgement = false;
      await evaluate(expression, contextId, options);
      throw new Error("CDP response was lost");
    }
    return evaluate(expression, contextId, options);
  };

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    operationId: "lost-acknowledgement-merge",
    merge: { from: 0, to: 1, itemId: "item-1", expectedTarget: "item-2" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.acknowledgement.operationId, "lost-acknowledgement-merge");
  assert.equal(fixture.live.mergeExecutions(), 1);
  assert.equal(fixture.legacyExecutions(), 0);
});

test("repeated transport failure returns a structured uncertain result after targeted verification", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();
  const evaluate = fixture.adapter.client.evaluate.bind(fixture.adapter.client);
  fixture.adapter.client.evaluate = async (expression, contextId, options) => {
    if (expression.startsWith("globalThis.miniGameCtl.executeCommand(")) {
      throw new Error("CDP command delivery failed");
    }
    return evaluate(expression, contextId, options);
  };

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    operationId: "failed-delivery-merge",
    merge: { from: 0, to: 1, itemId: "item-1", expectedTarget: "item-2" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.executed, true);
  assert.equal(result.reason, "semantic-merge-acknowledgement-lost");
  assert.equal(result.pauseRequested, true);
  assert.equal(result.acknowledgement.outcome, "bridge-failure");
  assert.equal(result.targetedVerification.signature, "item-1|item-1");
  assert.equal(fixture.live.mergeExecutions(), 0);
});

test("an accepted merge with an incomplete delta requires targeted verification", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();
  const evaluate = fixture.adapter.client.evaluate.bind(fixture.adapter.client);
  fixture.adapter.client.evaluate = async (expression, contextId, options) => {
    if (expression.startsWith("globalThis.miniGameCtl.executeCommand(")) {
      return {
        ok: true,
        outcome: "accepted-changed",
        reason: "merge-complete",
        operationId: "incomplete-delta-merge",
        method: "merge",
        expectedRevision: 0,
        revision: 1,
        changed: true,
        delta: { board: { grids: [] } },
      };
    }
    return evaluate(expression, contextId, options);
  };

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    operationId: "incomplete-delta-merge",
    merge: { from: 0, to: 1, itemId: "item-1", expectedTarget: "item-2" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "semantic-merge-acknowledgement-incomplete");
  assert.equal(result.pauseRequested, true);
  assert.equal(result.targetedVerification.signature, "item-1|item-1");
  assert.equal(fixture.live.mergeExecutions(), 0);
});

test("a detached cached controller is replaced from the current runtime before mutation", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();
  await vm.runInContext("globalThis.miniGameCtl.readBoard()", fixture.context);
  const replacement = mergeRuntime();
  fixture.live.runtime.mControllers = [replacement.boardController];

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    operationId: "replacement-controller-merge",
    merge: { from: 0, to: 1, itemId: "item-1", expectedTarget: "item-2" },
  });

  assert.equal(result.ok, true);
  assert.equal(fixture.live.mergeExecutions(), 0);
  assert.equal(replacement.mergeExecutions(), 1);
});

test("the order loop replans a stale semantic merge without recording a mutation", async () => {
  const state = normalizedBaseline();
  state.orders = [{
    slot: "order-1",
    taskId: 1,
    rewardCoins: 10,
    ready: false,
    items: [{ itemId: "item-2", complete: false, status: 0 }],
    requiredItemIds: ["item-2"],
    missingItemIds: ["item-2"],
  }];
  const plannedStates = [];
  const events = [];
  let boardActions = 0;
  const loop = new OrderCoinLoop({
    collectState: async () => state,
    planOrders: async (current) => {
      plannedStates.push(current);
      const target = {
        slot: "order-1",
        feasible: true,
        actionable: true,
        ready: false,
        nextAction: { type: "merge", from: 0, to: 1, itemId: "item-1", resultItemId: "item-2" },
        boardSpaceFeasibility: { feasible: true },
      };
      return { recommended: target, plans: [target], boundaryReason: null };
    },
    runBoardAction: async () => {
      boardActions += 1;
      if (boardActions === 1) {
        return {
          ok: false,
          executed: false,
          reason: "runtime-revision-stale",
          replanRequested: true,
          replanState: structuredClone(state),
          actions: [],
        };
      }
      return {
        ok: true,
        executed: true,
        reason: "merge-complete",
        stopReason: "max_actions_reached",
        actions: [{
          step: 1,
          type: "merge",
          from: 0,
          to: 1,
          itemId: "item-1",
          expectedTarget: "item-2",
          actualTarget: "item-2",
          verified: true,
        }],
      };
    },
    onEvent: (event) => events.push(event),
  });

  const result = await loop.run({ execute: true, maxActions: 1, initialState: state });

  assert.equal(result.ok, true);
  assert.equal(boardActions, 2);
  assert.equal(plannedStates.length, 2);
  assert.deepEqual(events.map((event) => event.type), ["merge"]);
});

test("semantic merge results continue through action history and Merge Relation evidence", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-merge-domain-flow-"));
  fs.writeFileSync(path.join(dataDir, "item-catalog.json"), JSON.stringify({
    rules: {},
    coverage: { completeChains: ["items"], incompleteChains: [] },
    chains: [{ id: "items", complete: true, minLevel: 1, maxLevel: 2, itemIds: ["item-1", "item-2"] }],
    items: [
      { id: "item-1", chainId: "items", level: 1, baseUnits: 1, mergeTarget: "item-2" },
      { id: "item-2", chainId: "items", level: 2, baseUnits: 2, mergeTarget: null },
    ],
    producers: [],
  }), "utf8");
  const state = normalizedBaseline();
  state.board.requiredItemCounts = { "item-2": 1 };
  state.orders = [{
    slot: "order-1",
    taskId: 1,
    rewardCoins: 10,
    ready: false,
    items: [{ itemId: "item-2", complete: false, status: 0 }],
    requiredItemIds: ["item-2"],
    missingItemIds: ["item-2"],
  }];
  const runtimeControl = new FakeRuntimeControlAdapter({
    states: [state],
    results: [{
      ok: true,
      executed: true,
      reason: "merge-complete",
      stopReason: "max_actions_reached",
      actions: [{
        step: 1,
        type: "merge",
        from: 0,
        to: 1,
        itemId: "item-1",
        expectedTarget: "item-2",
        actualTarget: "item-2",
        verified: true,
      }],
    }],
  });
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
    runtimeControl,
  });

  try {
    await runtime.start({ mode: "automatic", maxActions: 1 });
    while (runtime.passiveCatalogDrainPromise) await runtime.passiveCatalogDrainPromise;
    const sessionId = runtime.database.listSessions(1)[0].id;
    const history = runtime.database.listRecentActions(10)
      .filter((action) => Number(action.session_id) === Number(sessionId));
    const relation = runtime.database.getCatalogObject("merge-relation", "item-1");

    assert.deepEqual(history.map((action) => action.action_type), ["merge"]);
    assert.ok(relation.evidence.some((evidence) =>
      evidence.sourceType === "passive-action-diff"
      && evidence.sourceRef === "verified-merge"
      && evidence.payload.mergeTarget === "item-2"));
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("concurrent delivery of one operation ID shares the in-flight merge", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();
  let releaseMerge;
  let mergeCalls = 0;
  fixture.live.boardView.onDragEnd = async () => {
    mergeCalls += 1;
    await new Promise((resolve) => { releaseMerge = resolve; });
    fixture.live.source.itemId = "";
    fixture.live.source.item = null;
    fixture.live.source.isEmpty = true;
    fixture.live.target.itemId = "item-2";
    fixture.live.target.item = {
      itemConfig: { Level: 2, MergeTarget: "item-3", EnergyCost: 0, Price: 2 },
    };
  };
  const command = JSON.stringify({
    operationId: "concurrent-merge",
    expectedRevision: 0,
    method: "merge",
    sourceGrid: 0,
    targetGrid: 1,
    expectedItemId: "item-1",
    expectedResultItemId: "item-2",
  });

  const first = vm.runInContext(`globalThis.miniGameCtl.executeCommand(${command})`, fixture.context);
  const duplicate = vm.runInContext(`globalThis.miniGameCtl.executeCommand(${command})`, fixture.context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mergeCalls, 1);
  releaseMerge();

  assert.deepEqual(
    JSON.parse(JSON.stringify(await duplicate)),
    JSON.parse(JSON.stringify(await first)),
  );
  assert.equal(mergeCalls, 1);
});

test("ambiguous live board controllers keep semantic merge unsupported", async () => {
  const fixture = createAdapter();
  const duplicate = mergeRuntime();
  fixture.live.runtime.mControllers.push(duplicate.boardController);

  const readiness = await fixture.adapter.ready();
  const result = await fixture.adapter.execute({
    type: "run-board-action",
    merge: { from: 0, to: 1, itemId: "item-1", expectedTarget: "item-2" },
  });

  assert.equal(readiness.adapterId, "legacy-cdp");
  assert.deepEqual(result, { ok: true, reason: "legacy-action" });
  assert.equal(fixture.legacyExecutions(), 1);
  assert.equal(fixture.live.mergeExecutions(), 0);
  assert.equal(duplicate.mergeExecutions(), 0);
});

test("abort after semantic dispatch returns uncertainty and schedules reconciliation", async () => {
  const fixture = createAdapter();
  await fixture.adapter.ready();
  const evaluate = fixture.adapter.client.evaluate.bind(fixture.adapter.client);
  fixture.adapter.client.evaluate = async (expression, contextId, options) => {
    if (expression.startsWith("globalThis.miniGameCtl.executeCommand(")) {
      await evaluate(expression, contextId, options);
      throw Object.assign(new Error("request aborted after dispatch"), { name: "AbortError", code: "ABORT_ERR" });
    }
    return evaluate(expression, contextId, options);
  };

  const result = await fixture.adapter.execute({
    type: "run-board-action",
    operationId: "aborted-dispatch-merge",
    merge: { from: 0, to: 1, itemId: "item-1", expectedTarget: "item-2" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.executed, true);
  assert.equal(result.reason, "semantic-merge-aborted-after-dispatch");
  assert.equal(result.acknowledgement.outcome, "aborted");
  assert.equal(result.pauseRequested, false);
  assert.equal(fixture.live.mergeExecutions(), 1);

  await fixture.adapter.readState();
  const diagnostics = fixture.adapter.status().diagnostics;
  assert.equal(fixture.legacyReads(), 1);
  assert.equal(diagnostics.broadSnapshots, 1);
  assert.ok(diagnostics.targetedReads >= 1);
  assert.equal(diagnostics.resyncs, 1);
});
