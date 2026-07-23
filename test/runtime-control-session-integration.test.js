"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationRuntime } = require("../src/automation-runtime");
const { CdpClient } = require("../src/cdp-client");
const { FullAutomationLoop } = require("../src/full-automation-loop");
const { IdleAutomationSession } = require("../src/idle-automation-session");
const { OrderCoinLoop } = require("../src/order-coin-loop");
const {
  CdpRuntimeControlAdapter,
  FakeRuntimeControlAdapter,
  LegacyRuntimeControlAdapter,
} = require("../src/runtime-control-bridge");

function sessionState(phase, overrides = {}) {
  return {
    schemaVersion: 1,
    collectedAt: "2026-07-23T00:00:00.000Z",
    scene: "board",
    resources: { coins: 0, diamonds: 0, energy: 10 },
    energy: { amount: 10, limit: 10, recovering: false },
    board: {
      available: true,
      visible: true,
      width: 3,
      height: 1,
      occupied: 1,
      empty: 2,
      signature: phase,
      grids: [],
      mergeCandidates: [],
      requiredItemCounts: {},
    },
    warehouse: {
      inventoryKnowledge: { status: "unknown", slots: [], items: [], exchangeCapacity: 0 },
      storeAvailability: { status: "unknown" },
    },
    orders: [{ slot: "order-1", taskId: "task-1", ready: phase === "ready", items: [] }],
    mapMission: { canComplete: false, requirements: [] },
    phase,
    ...overrides,
  };
}

function planFor(state) {
  const orderPlan = {
    slot: "order-1",
    ready: state.phase === "ready",
    boardSpaceFeasibility: { feasible: true },
    producerSteps: [{ gridIndex: 0 }],
  };
  if (state.phase === "produce") {
    orderPlan.nextAction = {
      type: "produce",
      producer: 0,
      predictedBranches: [{ outcomeItemIds: ["leaf-1"] }],
    };
  } else if (state.phase === "merge") {
    orderPlan.nextAction = {
      type: "merge",
      from: 1,
      to: 2,
      itemId: "leaf-1",
      resultItemId: "leaf-2",
    };
  }
  return { recommended: orderPlan, plans: [orderPlan] };
}

function fullOrderLoop(runtimeControl, onPlan = null) {
  const orderLoop = new OrderCoinLoop({
    collectState: (signal) => runtimeControl.readState(signal),
    planOrders: async (state) => {
      onPlan?.();
      return planFor(state);
    },
    runBoardAction: ({ producer, merge, plannedAction, signal }) => runtimeControl.execute({ type: "run-board-action", producer, merge, plannedAction }, { signal }),
    submitOrder: (slot, { signal, before }) => runtimeControl.execute({ type: "submit-order", slot, before }, { signal }),
    reconcileBoardState: (_before, observed) => observed,
  });
  return new FullAutomationLoop({
    collectState: (signal) => runtimeControl.readState(signal),
    navigate: (target, { signal }) => runtimeControl.execute({ type: "navigate", target }, { signal }),
    runOrderCycle: (options) => orderLoop.run(options),
    completeMapMission: ({ signal }) => runtimeControl.execute({ type: "complete-map-mission" }, { signal }),
  });
}

test("a full order uses semantic navigation, stochastic production, merge, and submission without broad reads between actions", async () => {
  const mapState = sessionState("map", { scene: "map" });
  const productionState = sessionState("produce");
  const mergeState = sessionState("merge", {
    board: {
      ...sessionState("merge").board,
      occupied: 2,
      empty: 1,
      grids: [
        { index: 1, itemId: "leaf-1", normal: true, moveable: true },
        { index: 2, itemId: "leaf-1", normal: true, moveable: true },
      ],
      mergeCandidates: [{ from: 1, to: 2, itemId: "leaf-1" }],
    },
  });
  const readyState = sessionState("ready", {
    board: {
      ...sessionState("ready").board,
      grids: [{ index: 2, itemId: "leaf-2", normal: true, moveable: true }],
    },
  });
  const states = [mapState, productionState];
  const results = [
    {
      ok: true,
      reason: "navigation-verified",
      actions: [{ type: "navigate", target: "board", verified: true }],
      targetedVerification: { boardVisible: true },
    },
    {
      ok: true,
      reason: "production-complete",
      stopReason: "max_actions_reached",
      actions: [{ type: "produce", actualOutputItemIds: ["leaf-1"], verified: true }],
      observedState: mergeState,
      acknowledgement: { outcome: "accepted-changed", changed: true, delta: { producedItemIds: ["leaf-1"] } },
    },
    {
      ok: true,
      reason: "merge-complete",
      stopReason: "max_actions_reached",
      actions: [{ type: "merge", from: 1, to: 2, actualTarget: "leaf-2", verified: true }],
      observedState: readyState,
      acknowledgement: { outcome: "accepted-changed", changed: true, delta: { board: { grids: [{ index: 2, itemId: "leaf-2" }] } } },
    },
    {
      ok: true,
      reason: "order-submitted-and-coins-received",
      actions: [{ type: "submit-order", slot: "order-1", verified: true }],
      targetedVerification: { occupied: true, taskId: "task-2", coins: 10 },
    },
  ];
  const runtimeControl = new FakeRuntimeControlAdapter({ states, results });
  const legacyRuntimeControl = new FakeRuntimeControlAdapter({ states, results, controlPath: "legacy" });
  let replans = 0;

  const result = await fullOrderLoop(runtimeControl, () => { replans += 1; }).run({ execute: true });
  const legacyResult = await fullOrderLoop(legacyRuntimeControl).run({ execute: true });
  const status = runtimeControl.status();
  const legacyStatus = legacyRuntimeControl.status();

  assert.equal(result.reason, "order-completed");
  assert.equal(legacyResult.reason, "order-completed");
  assert.deepEqual(runtimeControl.commands.map((command) => command.type), [
    "navigate",
    "run-board-action",
    "run-board-action",
    "submit-order",
  ]);
  assert.deepEqual(legacyRuntimeControl.commands, runtimeControl.commands);
  assert.equal(replans, 3);
  assert.equal(runtimeControl.readCount, 2);
  assert.equal(status.diagnostics.baselineReads, 2);
  assert.equal(status.diagnostics.broadSnapshots, 0);
  assert.ok(status.diagnostics.broadSnapshots < legacyStatus.diagnostics.broadSnapshots);
  assert.equal(status.diagnostics.semanticCommands, 4);
  assert.equal(status.diagnostics.confirmationPaths.delta, 2);
  assert.equal(status.diagnostics.confirmationPaths.targeted, 2);
  assert.equal(status.diagnostics.targetedReads, 2);
  assert.ok(status.diagnostics.targetedReads < legacyStatus.diagnostics.targetedReads);
  assert.equal(status.diagnostics.confirmationLatencyMs.count, 4);
  assert.ok(status.diagnostics.confirmationLatencyMs.max >= 0);
});

test("idle wake reconciliation runs before the fresh state can reach a mutation", async () => {
  let releaseSleep;
  let reads = 0;
  const events = [];
  const session = new IdleAutomationSession({
    ensureConnection: async () => { events.push("connect"); },
    collectState: async () => {
      reads += 1;
      events.push(`read:${reads}`);
      return {
        resources: { energy: reads === 1 ? 0 : 1 },
        energy: reads === 1
          ? { amount: 0, limit: 10, recoverIntervalSeconds: 1, recoverTimestamp: 1, recovering: true }
          : { amount: 1, limit: 10, recovering: false },
      };
    },
    planState: async () => ({ recommended: { estimatedEnergy: 1 } }),
    runBoundedSession: async () => { events.push("mutate"); return { ok: false, reason: "done" }; },
    getRuntimeCheckpoint: () => ({ contextGeneration: "g1", revision: 4 }),
    reconcileBeforeMutation: async (checkpoint) => {
      events.push(`reconcile:${checkpoint.contextGeneration}:${checkpoint.revision}`);
      return { reconciled: true, reason: "idle-revision-changed" };
    },
    clock: {
      now: () => 0,
      sleep: (_ms, signal) => new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        signal?.addEventListener("abort", abort, { once: true });
        releaseSleep = () => { signal?.removeEventListener("abort", abort); resolve(); };
      }),
    },
  });

  const running = session.run();
  await new Promise((resolve) => setImmediate(resolve));
  releaseSleep();
  const result = await running;

  assert.equal(result.reason, "done");
  assert.ok(events.includes("reconcile:g1:4"));
  assert.ok(events.indexOf("reconcile:g1:4") < events.indexOf("read:2"));
  assert.ok(events.indexOf("read:2") < events.indexOf("mutate"));
});

test("idle generation invalidation reconnects and reconciles again before mutation", async () => {
  const pendingSleeps = [];
  let reads = 0;
  let connects = 0;
  let reconciliations = 0;
  const session = new IdleAutomationSession({
    ensureConnection: async () => { connects += 1; },
    collectState: async () => {
      reads += 1;
      return {
        resources: { energy: reads === 1 ? 0 : 1 },
        energy: reads === 1
          ? { amount: 0, limit: 10, recoverIntervalSeconds: 1, recoverTimestamp: 1, recovering: true }
          : { amount: 1, limit: 10, recovering: false },
      };
    },
    planState: async () => ({ recommended: { estimatedEnergy: 1 } }),
    runBoundedSession: async () => ({ ok: false, reason: "done" }),
    getRuntimeCheckpoint: () => ({ contextGeneration: "7", revision: 4 }),
    reconcileBeforeMutation: async () => {
      reconciliations += 1;
      if (reconciliations === 1) {
        throw Object.assign(new Error("execution context changed"), { code: "RUNTIME_CONTROL_CONTEXT_CHANGED" });
      }
      return { reconciled: true, reason: "idle-context-generation-changed" };
    },
    clock: {
      now: () => 0,
      sleep: () => new Promise((resolve) => pendingSleeps.push(resolve)),
    },
  });

  const running = session.run();
  await new Promise((resolve) => setImmediate(resolve));
  pendingSleeps.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  pendingSleeps.shift()();
  const result = await running;

  assert.equal(result.reason, "done");
  assert.equal(connects, 3);
  assert.equal(reconciliations, 2);
  assert.equal(reads, 2);
});

test("CDP diagnostics expose dispatched round trips and serialized request and result bytes", async () => {
  const client = new CdpClient();
  let requestPayload = null;
  client.socket = {
    readyState: 1,
    send(payload) { requestPayload = payload; },
  };

  const responsePayload = JSON.stringify({ id: 1, result: { ok: true } });
  const pending = client.send("Runtime.evaluate", { expression: "1 + 1" });
  client._handleMessage(responsePayload);
  await pending;

  assert.deepEqual(client.diagnosticsSnapshot(), {
    roundTrips: 1,
    requestBytes: Buffer.byteLength(requestPayload),
    resultBytes: Buffer.byteLength(responsePayload),
    methods: { "Runtime.evaluate": 1 },
  });
});

test("runtime status exports transport and recovery diagnostics after an idle revision change", async () => {
  const expressions = [];
  const client = {
    diagnosticsSnapshot: () => ({ roundTrips: 3, requestBytes: 120, resultBytes: 80, methods: { "Runtime.evaluate": 3 } }),
    evaluate: async (expression) => {
      expressions.push(expression);
      if (expression.includes("handshake()")) {
        return {
          protocolVersion: 1,
          bridgeVersion: "1.0.0",
          gameFingerprint: "game-a",
          contextGeneration: "7",
          revision: 5,
          capabilities: {
            baseline: true,
            boardRead: true,
            resourceRead: true,
            energyRead: true,
            orderRead: true,
            merge: true,
            production: true,
            orderSubmission: true,
            navigation: true,
          },
        };
      }
      if (expression.includes("drainEventQueue")) return [];
      if (expression.includes("readBoard")) return { ok: true, revision: 5, grids: [] };
      throw new Error(`unexpected expression: ${expression}`);
    },
  };
  const adapter = new CdpRuntimeControlAdapter({
    client,
    contextId: 7,
    legacy: { readState: async () => { throw new Error("broad snapshot should not run"); } },
  });
  adapter.readiness = {
    adapterId: "semantic-cdp",
    protocolVersion: 1,
    bridgeVersion: "1.0.0",
    gameFingerprint: "game-a",
    contextGeneration: "7",
    revision: 4,
    capabilities: {
      baseline: true,
      boardRead: true,
      resourceRead: true,
      energyRead: true,
      orderRead: true,
      merge: true,
      production: true,
      orderSubmission: true,
      navigation: true,
    },
  };

  const reconciliation = await adapter.reconcileForMutation({
    contextGeneration: "7",
    revision: 4,
    gameFingerprint: "game-a",
  });
  const status = adapter.status();

  assert.equal(reconciliation.reconciled, true);
  assert.equal(reconciliation.reason, "idle-runtime-revision-changed");
  assert.deepEqual(expressions.map((expression) => expression.match(/\.(handshake|drainEventQueue|readBoard)/)?.[1]), [
    "handshake",
    "drainEventQueue",
    "readBoard",
  ]);
  assert.equal(status.latestRecoveryReason, "idle-runtime-revision-changed");
  assert.equal(status.diagnostics.resyncs, 1);
  assert.equal(status.diagnostics.targetedReads, 3);
  assert.equal(status.diagnostics.broadSnapshots, 0);
  assert.deepEqual(status.diagnostics.transport, client.diagnosticsSnapshot());
});

test("a changed execution-context generation is invalidated instead of recovering through the stale context", async () => {
  const expressions = [];
  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => {
        expressions.push(expression);
        return {
          protocolVersion: 1,
          bridgeVersion: "1.0.0",
          gameFingerprint: "game-a",
          contextGeneration: "8",
          revision: 5,
          capabilities: {
            baseline: true,
            boardRead: true,
            resourceRead: true,
            energyRead: true,
            orderRead: true,
            merge: true,
            production: true,
            orderSubmission: true,
            navigation: true,
          },
        };
      },
    },
    contextId: 7,
    legacy: { readState: async () => { throw new Error("stale Legacy context must not be used"); } },
  });
  adapter.readiness = {
    adapterId: "semantic-cdp",
    protocolVersion: 1,
    bridgeVersion: "1.0.0",
    gameFingerprint: "game-a",
    contextGeneration: "7",
    revision: 4,
    capabilities: {},
  };

  await assert.rejects(
    adapter.reconcileForMutation({ contextGeneration: "7", revision: 4, gameFingerprint: "game-a" }),
    (error) => error.code === "RUNTIME_CONTROL_CONTEXT_CHANGED",
  );
  const status = adapter.status();
  assert.equal(expressions.length, 1);
  assert.match(expressions[0], /handshake/);
  assert.equal(status.latestRecoveryReason, "idle-context-generation-changed");
  assert.equal(status.diagnostics.resyncs, 1);
  assert.equal(status.diagnostics.broadSnapshots, 0);
});

test("Automation Runtime drops a stale context so the idle session reconnects before mutation", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-context-reset-"));
  const runtime = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  let closed = 0;
  const contextError = Object.assign(new Error("execution context changed"), { code: "RUNTIME_CONTROL_CONTEXT_CHANGED" });
  runtime.runtimeControl = { reconcileForMutation: async () => { throw contextError; } };
  runtime.selection = { probe: { context: { id: 7 } } };
  runtime.lab = { close: async () => { closed += 1; } };

  try {
    await assert.rejects(
      runtime.reconcileRuntimeControlForMutation({ contextGeneration: "7", revision: 4 }),
      (error) => error === contextError,
    );
    assert.equal(closed, 1);
    assert.equal(runtime.runtimeControl, null);
    assert.equal(runtime.selection, null);
    assert.equal(runtime.lab, null);
  } finally {
    runtime.database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("one unavailable semantic capability records a per-capability Legacy fallback without disabling the bridge", async () => {
  const legacyCommands = [];
  const adapter = new CdpRuntimeControlAdapter({
    client: { diagnosticsSnapshot: () => ({ roundTrips: 0, requestBytes: 0, resultBytes: 0, methods: {} }) },
    contextId: 7,
    legacy: {
      execute: async (command) => {
        legacyCommands.push(command.type);
        return { ok: true, reason: "legacy-merge-complete", actions: [{ type: "merge", verified: true }] };
      },
    },
  });
  adapter.readiness = {
    adapterId: "semantic-cdp",
    protocolVersion: 1,
    bridgeVersion: "1.0.0",
    gameFingerprint: "game-a",
    contextGeneration: "7",
    revision: 4,
    capabilities: { state: true, production: true, merge: false, orderSubmission: true, navigation: true },
  };

  const result = await adapter.execute({
    type: "run-board-action",
    plannedAction: { type: "merge", from: 1, to: 2, itemId: "leaf-1", resultItemId: "leaf-2" },
  });
  const status = adapter.status();

  assert.equal(result.reason, "legacy-merge-complete");
  assert.deepEqual(legacyCommands, ["run-board-action"]);
  assert.equal(status.ready, true);
  assert.equal(status.capabilities.production, true);
  assert.equal(status.diagnostics.fallbacks, 1);
  assert.equal(status.diagnostics.confirmationPaths.legacy, 1);
  assert.equal(status.diagnostics.confirmationLatencyMs.count, 1);
  assert.deepEqual(status.latestFallback, { capability: "merge", reason: "semantic-capability-unavailable" });
});

test("Legacy execution records confirmation latency", async () => {
  const legacy = new LegacyRuntimeControlAdapter({
    lab: {
      client: {
        evaluate: async () => ({ boardVisible: true, mapVisible: false, mapMissionVisible: false }),
      },
    },
    selection: { probe: { context: { id: 7 } } },
    collectState: async () => sessionState("legacy"),
  });

  const result = await legacy.execute({ type: "navigate", target: "board" });
  const status = legacy.status();

  assert.equal(result.reason, "already-there");
  assert.equal(status.diagnostics.confirmationPaths.legacy, 1);
  assert.equal(status.diagnostics.confirmationLatencyMs.count, 1);
  assert.ok(status.diagnostics.confirmationLatencyMs.max >= 0);
});

test("diagnostic export payload includes runtime readiness, capability, fallback, recovery, and counters", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-control-diagnostics-"));
  const runtimeControl = new FakeRuntimeControlAdapter({
    readiness: {
      adapterId: "fake-runtime-control",
      protocolVersion: 1,
      bridgeVersion: "1.0.0",
      gameFingerprint: "game-a",
      contextGeneration: "g1",
      revision: 9,
      capabilities: { merge: true },
    },
  });
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
    runtimeControl,
  });

  try {
    const payload = runtime.buildDiagnosticPayload(sessionState("diagnostic"));
    assert.equal(payload.runtimeControl.ready, true);
    assert.equal(payload.runtimeControl.gameFingerprint, "game-a");
    assert.equal(payload.runtimeControl.contextGeneration, "g1");
    assert.equal(payload.runtimeControl.revision, 9);
    assert.equal(payload.runtimeControl.capabilities.merge, true);
    assert.equal(payload.runtimeControl.fallback.active, false);
    assert.equal(payload.runtimeControl.latestRecoveryReason, null);
    assert.equal(payload.runtimeControl.diagnostics.baselineReads, 0);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
