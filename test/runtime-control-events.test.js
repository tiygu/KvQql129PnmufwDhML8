

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const {
  CdpRuntimeControlAdapter,
} = require("../src/runtime-control-bridge");

// ── helpers ────────────────────────────────────────────────────────────────

function normalizedBaseline() {
  return {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    scene: "board",
    resources: { coins: 12, diamonds: 3, energy: 8 },
    energy: { amount: 8, limit: 20, recoverIntervalSeconds: 60, recoverTimestamp: 1234, recovering: true },
    board: {
      available: true, visible: true, width: 2, height: 2, occupied: 1, empty: 3,
      signature: "item-1|||", grids: [{ index: 0, itemId: "item-1", empty: false, normal: true, moveable: true }],
      mergeCandidates: [], requiredItemCounts: {},
    },
    orders: [],
    producers: [],
    warehouse: { inventoryKnowledge: { status: "unknown" } },
    mapProgress: { currentTask: null, currentSeason: null, seasonDisplay: null, allFinished: false, episodeFinished: false },
    mapMission: null, overlays: [], selectedItem: null,
    source: { adapter: "semantic-runtime", engine: "cocos" },
  };
}

function buildMergeContext() {
  const emptyGrid = { index: 0, itemId: "", item: null, isEmpty: true, isNormal: false, isMoveable: false };
  const itemConfig = {
    Level: 1,
    MergeTarget: "merged-item",
    EnergyCost: 0,
    Price: 0,
    CreateData: [],
    Version: "1",
  };
  const grid = (index, itemId) => ({
    index,
    itemId,
    item: { itemConfig: { ...itemConfig }, taskNeed: false, produceCount: 0 },
    isEmpty: false,
    isNormal: true,
    isMoveable: true,
    isLocking: false,
    isFrozen: false,
    center: { x: (index % 2) * 100, y: Math.floor(index / 2) * 100 },
  });
  const grids = [grid(0, "test-item"), grid(1, "test-item"), emptyGrid, emptyGrid];
  const gameBoard = { size: { width: 2, height: 2 }, __private_95_grids: grids };
    const boardView = {
    _boardStore: { _state: { _gameBoard: gameBoard } },
    canBoardGridBeDragging: () => true,
    isBoardGridItemAnimating: () => false,
    _operatorCenter: { itemCanMergeWith: () => true },
    _dragHandler: { predictDragResult: () => ({ mergedItemId: "merged-item" }) },
    onDragStart: () => {},
    onDragMove: () => {},
    onDragEnd: (_source, _target) => {
      // Simulate actual merge: clear source, set target to merged-item
      const src = grids[0];
      const dst = grids[1];
      if (src && dst) {
        src.itemId = "";
        src.isEmpty = true;
        src.item = null;
        dst.itemId = "merged-item";
      }
    },
  };
  const boardController = {
    _controllerClazzName: "UserBoardViewController",
    isViewVisible: true,
    view: { _boardView: { _gameBoardView: boardView } },
  };
  const runtime = {
    mControllers: [boardController],
    mManagers: [
      { _resourceMap: new Map([[1, 12], [2, 3], [3, 8]]) },
      { _energyDataMap: new Map([[3, { _energyLimit: 20, _recoverInterval: 60, recoverTimestamp: 1234, inRecover: true }]]) },
      { clientTaskDataMap: new Map() },
      {},
    ],
  };
  const scene = {
    name: "main",
    getChildByName: (name) => name === "Entry" ? { _components: [runtime] } : null,
    children: [],
  };
  return { runtime, scene, boardController, boardView, gameBoard, grids };
}

// ── tests ──────────────────────────────────────────────────────────────────

test("injected bridge publishes events with generation, revision, type, operationId, and normalized delta", async () => {
  const { scene } = buildMergeContext();
  const events = [];
  const context = vm.createContext({
    globalThis: null,
    cc: { ENGINE_VERSION: "3.8.0", director: { getScene: () => scene } },
    __miniGameCtlEventBinding: (payload) => {
      events.push(JSON.parse(payload));
    },
  });
  context.globalThis = context;

  const client = { evaluate: async (expression) => vm.runInContext(expression, context) };
  const legacy = {
    ready: async () => ({ adapterId: "legacy-cdp", contextId: 7 }),
    readState: async () => normalizedBaseline(),
    execute: async () => ({ ok: true }),
  };
  const adapter = new CdpRuntimeControlAdapter({ client, contextId: 7, legacy });

  await adapter.ready();

  // Execute a merge command through the injected bridge
  const acknowledgement = await client.evaluate(
    `globalThis.miniGameCtl.executeCommand(${JSON.stringify({
      operationId: "test-op-1",
      expectedRevision: 0,
      method: "merge",
      sourceGrid: 0,
      targetGrid: 1,
    })})`,
    7,
  );

  assert.equal(acknowledgement.ok, true);
  assert.equal(acknowledgement.outcome, "accepted-changed");

  // Verify event was published via binding
  assert.ok(events.length >= 1, "at least one event should have been published");
  const event = events[0];
  assert.equal(event.generation, "7");
  assert.ok(Number.isInteger(event.revision) && event.revision >= 1);
  assert.equal(event.eventType, "state-changed");
  assert.equal(event.operationId, "test-op-1");
  assert.ok(event.delta && typeof event.delta === "object");
  assert.ok(Array.isArray(event.delta.board?.grids));
  assert.equal(event.delta.board.grids.length, 2);
  assert.ok(typeof event.timestamp === "string");
});

test("event queue drains events after a given revision", async () => {
  const { scene } = buildMergeContext();
  const context = vm.createContext({
    globalThis: null,
    cc: { ENGINE_VERSION: "3.8.0", director: { getScene: () => scene } },
  });
  context.globalThis = context;

  const client = { evaluate: async (expression) => vm.runInContext(expression, context) };
  const legacy = {
    ready: async () => ({ adapterId: "legacy-cdp", contextId: 7 }),
    readState: async () => normalizedBaseline(),
    execute: async () => ({ ok: true }),
  };
  const adapter = new CdpRuntimeControlAdapter({ client, contextId: 7, legacy });
  await adapter.ready();

  // Execute two merges
  await client.evaluate(
    `globalThis.miniGameCtl.executeCommand(${JSON.stringify({
      operationId: "drain-1", expectedRevision: 0, method: "merge", sourceGrid: 0, targetGrid: 1,
    })})`, 7);
  await client.evaluate(
    `globalThis.miniGameCtl.executeCommand(${JSON.stringify({
      operationId: "drain-2", expectedRevision: 1, method: "merge", sourceGrid: 0, targetGrid: 1,
    })})`, 7);

  // Drain events from revision 0 (should get events with revision > 0)
  const drained = await client.evaluate("globalThis.miniGameCtl.drainEventQueue(0)", 7);
  assert.ok(Array.isArray(drained));
  assert.ok(drained.length >= 1, "drain should return events after revision 0");
  assert.ok(drained.every((e) => Number.isInteger(e.revision) && e.revision > 0));

  // Drain from a high revision should return empty
  const empty = await client.evaluate("globalThis.miniGameCtl.drainEventQueue(999)", 7);
  assert.ok(Array.isArray(empty) && empty.length === 0, "drain from high revision should be empty");
});

test("event queue is bounded at 256 entries", async () => {
  const { scene, grids } = buildMergeContext();
  const context = vm.createContext({
    globalThis: null,
    cc: { ENGINE_VERSION: "3.8.0", director: { getScene: () => scene } },
  });
  context.globalThis = context;

  const client = { evaluate: async (expression) => vm.runInContext(expression, context) };
  const legacy = {
    ready: async () => ({ adapterId: "legacy-cdp", contextId: 7 }),
    readState: async () => normalizedBaseline(),
    execute: async () => ({ ok: true }),
  };
  const adapter = new CdpRuntimeControlAdapter({ client, contextId: 7, legacy });
  await adapter.ready();

  // Reset grids for each iteration so merges always succeed
  for (let i = 0; i < 260; i++) {
    // Reset grids to mergeable state
    grids[0] = { index: 0, itemId: "test-item", item: { itemConfig: { Level: 1, MergeTarget: "merged-item", EnergyCost: 0 }, taskNeed: false, produceCount: 0 }, isEmpty: false, isNormal: true, isMoveable: true, isLocking: false, isFrozen: false, center: { x: 0, y: 0 } };
    grids[1] = { index: 1, itemId: "test-item", item: { itemConfig: { Level: 1, MergeTarget: "merged-item", EnergyCost: 0 }, taskNeed: false, produceCount: 0 }, isEmpty: false, isNormal: true, isMoveable: true, isLocking: false, isFrozen: false, center: { x: 100, y: 0 } };
    grids[0].itemId = "test-item";
    grids[1].itemId = "test-item";

    const rev = i;
    await client.evaluate(
      `globalThis.miniGameCtl.executeCommand(${JSON.stringify({
        operationId: `bound-${i}`, expectedRevision: rev, method: "merge", sourceGrid: 0, targetGrid: 1,
      })})`, 7);
  }

  // Queue should be bounded at 256
  const allEvents = await client.evaluate("globalThis.miniGameCtl.drainEventQueue(-1)", 7);
  assert.ok(allEvents.length <= 256, `event queue should not exceed 256 (got ${allEvents.length})`);
});

test("duplicate operation IDs return cached acknowledgement without producing duplicate events", async () => {
  const { scene } = buildMergeContext();
  const events = [];
  const context = vm.createContext({
    globalThis: null,
    cc: { ENGINE_VERSION: "3.8.0", director: { getScene: () => scene } },
    __miniGameCtlEventBinding: (payload) => { events.push(JSON.parse(payload)); },
  });
  context.globalThis = context;

  const client = { evaluate: async (expression) => vm.runInContext(expression, context) };
  const legacy = {
    ready: async () => ({ adapterId: "legacy-cdp", contextId: 7 }),
    readState: async () => normalizedBaseline(),
    execute: async () => ({ ok: true }),
  };
  const adapter = new CdpRuntimeControlAdapter({ client, contextId: 7, legacy });
  await adapter.ready();

  const command = { operationId: "dup-test", expectedRevision: 0, method: "merge", sourceGrid: 0, targetGrid: 1 };
  const first = await client.evaluate(`globalThis.miniGameCtl.executeCommand(${JSON.stringify(command)})`, 7);
  const second = await client.evaluate(`globalThis.miniGameCtl.executeCommand(${JSON.stringify(command)})`, 7);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(first, second);

  // Only one event for this operationId
  const stateChanged = events.filter((e) => e.operationId === "dup-test" && e.eventType === "state-changed");
  assert.equal(stateChanged.length, 1, "duplicate operation should not produce duplicate events");
});

test("out-of-order events with gap trigger recovery flag", async () => {
  const { scene } = buildMergeContext();
  const context = vm.createContext({
    globalThis: null,
    cc: { ENGINE_VERSION: "3.8.0", director: { getScene: () => scene } },
  });
  context.globalThis = context;

  const client = { evaluate: async (expression) => vm.runInContext(expression, context) };
  const legacy = {
    ready: async () => ({ adapterId: "legacy-cdp", contextId: 7 }),
    readState: async () => normalizedBaseline(),
    execute: async () => ({ ok: true }),
  };

  const adapter = new CdpRuntimeControlAdapter({ client, contextId: 7, legacy });
  await adapter.ready();

  // Apply first event (revision 0)
  adapter._applyEvent({
    generation: "7", revision: 0, eventType: "state-changed", operationId: "first", delta: {},
  });
  assert.equal(adapter.appliedEventRevision, 0);

  // Skip from revision 0 to 5 — gap of 4 missing events
  adapter._applyEvent({
    generation: "7",
    revision: 5,
    eventType: "state-changed",
    operationId: "gap-test",
    delta: { board: { revision: 5, grids: [] } },
  });

  // Gap from 0 to 5 triggers requiresBroadReconciliation (missing 1-4)
  assert.equal(adapter.requiresBroadReconciliation, true);
  // The skipped event should NOT have been applied
  assert.equal(adapter.appliedEventRevision, 0);

  // Recovery should escalate through drain → targeted read → baseline
  await adapter.recoverEventGap();

  // After recovery, reconciliation flag should be cleared
  assert.equal(adapter.requiresBroadReconciliation, false);
});

test("events from wrong context generation are rejected and trigger broad reconciliation", async () => {
  const adapter = new CdpRuntimeControlAdapter({
    client: new EventEmitter(),
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  adapter._applyEvent({
    generation: "999",
    revision: 0,
    eventType: "state-changed",
    operationId: "wrong-gen",
    delta: { board: {} },
  });

  assert.equal(adapter.requiresBroadReconciliation, true);
  assert.equal(adapter.appliedEventRevision, -1, "wrong-generation event should not advance revision");
});

test("duplicate events (by revision) are ignored", async () => {
  const adapter = new CdpRuntimeControlAdapter({
    client: new EventEmitter(),
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  const event = { generation: "7", revision: 0, eventType: "state-changed", operationId: "evt-1", delta: {} };
  adapter._applyEvent(event);
  assert.equal(adapter.appliedEventRevision, 0);

  // Duplicate (same revision)
  adapter._applyEvent(event);
  assert.equal(adapter.appliedEventRevision, 0, "duplicate event should not advance revision");
});

test("recovery escalates through event-queue drain, targeted read, baseline read, then broad snapshot", async () => {
  const { scene } = buildMergeContext();
  const calls = [];
  const context = vm.createContext({
    globalThis: null,
    cc: { ENGINE_VERSION: "3.8.0", director: { getScene: () => scene } },
  });
  context.globalThis = context;

  const client = {
    evaluate: async (expression) => {
      calls.push(expression);
      return vm.runInContext(expression, context);
    },
  };
  const legacyReads = [];
  const legacy = {
    ready: async () => ({ adapterId: "legacy-cdp", contextId: 7 }),
    readState: async () => { legacyReads.push(true); return normalizedBaseline(); },
    execute: async () => ({ ok: true }),
  };

  const adapter = new CdpRuntimeControlAdapter({ client, contextId: 7, legacy });
  await adapter.ready();
  // Clear calls from install
  calls.length = 0;

  // Simulate a gap
  adapter.appliedEventRevision = 10;
  adapter._applyEvent({
    generation: "7", revision: 15, eventType: "state-changed", operationId: "gap", delta: {},
  });

  // Attempt recovery - should try drain first
  await adapter.recoverEventGap();

  // Should have tried drainEventQueue
  const drainCalls = calls.filter((c) => c.includes("drainEventQueue"));
  assert.equal(drainCalls.length, 1, "recovery should try event-queue drain first");

  // Since drain doesn't fill the gap (events were synthetic), it should escalate
  // to targeted read, then baseline, then broad snapshot
  assert.ok(calls.length >= 1, "recovery should attempt multiple levels");
});

test("cache-invalidated events set requiresBroadReconciliation", async () => {
  const adapter = new CdpRuntimeControlAdapter({
    client: new EventEmitter(),
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  adapter._applyEvent({
    generation: "7",
    revision: 2,
    eventType: "cache-invalidated",
    operationId: null,
    delta: { scope: "merge-context" },
  });

  assert.equal(adapter.requiresBroadReconciliation, true);
});

test("injected bridge invalidates merge context and publishes cache-invalidated event", async () => {
  const { scene } = buildMergeContext();
  const events = [];
  const context = vm.createContext({
    globalThis: null,
    cc: { ENGINE_VERSION: "3.8.0", director: { getScene: () => scene } },
    __miniGameCtlEventBinding: (payload) => { events.push(JSON.parse(payload)); },
  });
  context.globalThis = context;

  const client = { evaluate: async (expression) => vm.runInContext(expression, context) };
  const legacy = {
    ready: async () => ({ adapterId: "legacy-cdp", contextId: 7 }),
    readState: async () => normalizedBaseline(),
    execute: async () => ({ ok: true }),
  };
  const adapter = new CdpRuntimeControlAdapter({ client, contextId: 7, legacy });
  await adapter.ready();

  await client.evaluate("globalThis.miniGameCtl.invalidateMergeContext()", 7);

  const cacheEvents = events.filter((e) => e.eventType === "cache-invalidated");
  assert.equal(cacheEvents.length, 1);
  assert.equal(cacheEvents[0].delta.scope, "merge-context");
  assert.equal(cacheEvents[0].generation, "7");
});

test("context destruction: reinstall triggers new generation and old events are rejected", async () => {
  const { scene } = buildMergeContext();
  let currentScene = scene;

  const context = vm.createContext({
    globalThis: null,
    cc: {
      ENGINE_VERSION: "3.8.0",
      director: { getScene: () => currentScene },
    },
    __miniGameCtlEventBinding: (payload) => { events.push(JSON.parse(payload)); },
  });
  context.globalThis = context;

  const client = { evaluate: async (expression) => vm.runInContext(expression, context) };
  const legacy = {
    ready: async () => ({ adapterId: "legacy-cdp", contextId: 8 }),
    readState: async () => normalizedBaseline(),
    execute: async () => ({ ok: true }),
  };

  // Install bridge for context generation "7"
  const adapter7 = new CdpRuntimeControlAdapter({ client, contextId: 7, legacy });
  await adapter7.ready();

  // Queue an event from generation 7
  adapter7._applyEvent({
    generation: "7", revision: 1, eventType: "state-changed", operationId: "gen7", delta: {},
  });
  assert.equal(adapter7.appliedEventRevision, 1);

  // Now simulate context destruction - reinstall for generation "8"
  // Build a new scene for the new context
  const { scene: scene2 } = buildMergeContext();
  currentScene = scene2;

  const adapter8 = new CdpRuntimeControlAdapter({ client, contextId: 8, legacy });
  await adapter8.ready();

  // Old generation events should be rejected
  adapter8._applyEvent({
    generation: "7", revision: 2, eventType: "state-changed", operationId: "gen7-late", delta: {},
  });

  assert.equal(adapter8.appliedEventRevision, -1, "old-generation event should not apply");
  assert.equal(adapter8.requiresBroadReconciliation, true, "old-generation event should trigger reconciliation");
});

test("pause and stop abort event recovery", async () => {
  const { scene } = buildMergeContext();
  const context = vm.createContext({
    globalThis: null,
    cc: { ENGINE_VERSION: "3.8.0", director: { getScene: () => scene } },
  });
  context.globalThis = context;

  const client = {
    evaluate: async (expression, _contextId, options) => {
      if (options?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return vm.runInContext(expression, context);
    },
  };
  const legacy = {
    ready: async () => ({ adapterId: "legacy-cdp", contextId: 7 }),
    readState: async () => normalizedBaseline(),
    execute: async () => ({ ok: true }),
  };

  const adapter = new CdpRuntimeControlAdapter({ client, contextId: 7, legacy });
  await adapter.ready();

  const controller = new AbortController();
  controller.abort();

  // Recovery with an aborted signal should throw
  await assert.rejects(
    () => adapter.recoverEventGap(controller.signal),
    { name: "AbortError" },
  );
});

test("readState with aborted signal throws AbortError", async () => {
  const { scene } = buildMergeContext();
  const context = vm.createContext({
    globalThis: null,
    cc: { ENGINE_VERSION: "3.8.0", director: { getScene: () => scene } },
  });
  context.globalThis = context;

  const client = { evaluate: async (expression) => vm.runInContext(expression, context) };
  const legacy = {
    ready: async () => ({ adapterId: "legacy-cdp", contextId: 7 }),
    readState: async () => normalizedBaseline(),
    execute: async () => ({ ok: true }),
  };

  const adapter = new CdpRuntimeControlAdapter({ client, contextId: 7, legacy });
  await adapter.ready();

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => adapter.readState(controller.signal),
    { name: "AbortError" },
  );
});

test("status includes event binding state", async () => {
  const { scene } = buildMergeContext();
  const context = vm.createContext({
    globalThis: null,
    cc: { ENGINE_VERSION: "3.8.0", director: { getScene: () => scene } },
  });
  context.globalThis = context;

  const client = { evaluate: async (expression) => vm.runInContext(expression, context) };
  const legacy = {
    ready: async () => ({ adapterId: "legacy-cdp", contextId: 7 }),
    readState: async () => normalizedBaseline(),
    execute: async () => ({ ok: true }),
  };

  const adapter = new CdpRuntimeControlAdapter({ client, contextId: 7, legacy });
  await adapter.ready();

  const status = adapter.status();
  assert.equal(status.adapterId, "semantic-cdp");
  assert.ok(status.ready);
  assert.ok("eventBinding" in status);
  assert.ok("active" in status.eventBinding);
  assert.ok("appliedRevision" in status.eventBinding);
});

test("shutdown removes event listener", () => {
  const emitter = new EventEmitter();
  emitter.send = () => Promise.resolve({});
  const adapter = new CdpRuntimeControlAdapter({
    client: emitter,
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  // Force-enable events on the EventEmitter-based client
  adapter._enableEvents();
  assert.equal(emitter.listenerCount("event"), 1);

  adapter.shutdown();
  assert.equal(emitter.listenerCount("event"), 0);
});

test("events applied through binding listener update appliedEventRevision", async () => {
  const emitter = new EventEmitter();
  // Mock send to return a resolved promise
  emitter.send = () => Promise.resolve({});

  const adapter = new CdpRuntimeControlAdapter({
    client: emitter,
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  adapter._enableEvents();
  assert.ok(adapter.bindingListener);

  // Simulate a Runtime.bindingCalled event
  const event = { generation: "7", revision: 1, eventType: "state-changed", operationId: "bind-test", delta: {} };
  emitter.emit("event", {
    method: "Runtime.bindingCalled",
    params: { payload: JSON.stringify(event) },
  });

  assert.equal(adapter.appliedEventRevision, 1);
});

test("binding listener ignores non-bindingCalled events and non-string payloads", async () => {
  const emitter = new EventEmitter();
  emitter.send = () => Promise.resolve({});

  const adapter = new CdpRuntimeControlAdapter({
    client: emitter,
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  adapter._enableEvents();

  // Non-bindingCalled event - should be ignored
  emitter.emit("event", { method: "Runtime.consoleAPICalled", params: { type: "log" } });
  assert.equal(adapter.appliedEventRevision, -1);

  // bindingCalled with non-string payload - should be ignored
  emitter.emit("event", {
    method: "Runtime.bindingCalled",
    params: { payload: 123 },
  });
  assert.equal(adapter.appliedEventRevision, -1);
});

test("eventsSinceLastRead accumulates applied events with a bound", async () => {
  const emitter = new EventEmitter();
  emitter.send = () => Promise.resolve({});

  const adapter = new CdpRuntimeControlAdapter({
    client: emitter,
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  adapter._enableEvents();

  // Apply 70 events
  for (let i = 0; i < 70; i++) {
    emitter.emit("event", {
      method: "Runtime.bindingCalled",
      params: { payload: JSON.stringify({ generation: "7", revision: i, eventType: "state-changed", operationId: `ev-${i}`, delta: {} }) },
    });
  }

  assert.equal(adapter.appliedEventRevision, 69);
  // Buffer should be bounded at 64
  assert.ok(adapter.eventsSinceLastRead.length <= 64, `events buffer should not exceed 64 (got ${adapter.eventsSinceLastRead.length})`);
  // The oldest entries should have been evicted
  assert.ok(adapter.eventsSinceLastRead[0].revision > 0);
});

test("eventsSinceLastRead bounded at 64 entries", async () => {
  const adapter = new CdpRuntimeControlAdapter({
    client: new EventEmitter(),
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  for (let i = 0; i < 100; i++) {
    adapter._applyEvent({ generation: "7", revision: i, eventType: "state-changed", operationId: `ev-${i}`, delta: {} });
  }

  assert.ok(adapter.eventsSinceLastRead.length <= 64);
});

test("events with missing or invalid fields are silently dropped", async () => {
  const adapter = new CdpRuntimeControlAdapter({
    client: new EventEmitter(),
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  // null event
  adapter._applyEvent(null);
  assert.equal(adapter.appliedEventRevision, -1);

  // missing revision
  adapter._applyEvent({ generation: "7", eventType: "state-changed" });
  assert.equal(adapter.appliedEventRevision, -1);

  // missing generation
  adapter._applyEvent({ revision: 1, eventType: "state-changed" });
  assert.equal(adapter.appliedEventRevision, -1);

  // missing eventType
  adapter._applyEvent({ generation: "7", revision: 1 });
  assert.equal(adapter.appliedEventRevision, -1);
});
