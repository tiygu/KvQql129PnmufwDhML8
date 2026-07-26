"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IdleAutomationSession, computeEnergyWakeDelay } = require("../src/idle-automation-session");
const { AutomationDatabase } = require("../src/automation-database");
const { AutomationRuntime } = require("../src/automation-runtime");
const { OrderSubmitter } = require("../src/order-actions");
const { WarehouseActionExecutor } = require("../src/warehouse-actions");
const { CdpClient } = require("../src/cdp-client");

class FakeClock {
  constructor(now = 1_700_000_000_000) { this.time = now; this.pending = []; this.aborted = 0; }
  now = () => this.time;
  sleep = (ms, signal) => new Promise((resolve, reject) => {
    const pending = { ms, resolve, reject };
    const abort = () => { this.aborted += 1; this.pending = this.pending.filter((item) => item !== pending); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    pending.finish = () => { signal?.removeEventListener("abort", abort); this.time += ms; resolve(); };
    this.pending.push(pending);
  });
  advanceOne() { const pending = this.pending.shift(); if (pending) pending.finish(); }
}

function state(energy, overrides = {}) {
  return {
    resources: { energy },
    energy: { amount: energy, limit: 10, recoverIntervalSeconds: 60, recoverTimestamp: 1_700_000_060_000, recovering: true },
    ...overrides,
  };
}

test("wake delay uses live energy limit, interval, and recovery timestamp", () => {
  assert.equal(computeEnergyWakeDelay(state(1), { requiredEnergy: 3, now: 1_700_000_000_000 }), 120_000);
  assert.equal(computeEnergyWakeDelay(state(9), { requiredEnergy: 9, now: 1_700_000_000_000 }), 0);
  assert.equal(computeEnergyWakeDelay(state(1, { energy: { amount: 1, limit: 10, recoverIntervalSeconds: null, recoverTimestamp: null } }), { requiredEnergy: 3, now: 1_700_000_000_000 }), 60_000);
});

test("idle session sleeps once, reconnects, reads fresh state, and replans before acting", async () => {
  const clock = new FakeClock();
  let reads = 0, connects = 0, plans = 0, runs = 0;
  const session = new IdleAutomationSession({
    clock,
    ensureConnection: async () => { connects += 1; },
    collectState: async () => state(reads++ ? 3 : 1),
    planState: async () => { plans += 1; return { recommended: { estimatedEnergy: 3 } }; },
    runBoundedSession: async () => { runs += 1; return { ok: true, reason: "evidence-waiting" }; },
  });
  const running = session.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.pending.length, 1);
  assert.equal(runs, 0);
  clock.advanceOne();
  const result = await running;
  assert.equal(result.reason, "evidence-waiting");
  assert.equal(connects, 2);
  assert.equal(reads, 2);
  assert.equal(plans, 2);
  assert.equal(runs, 1);
});

test("the first connection retry keeps automatic startup responsive", async () => {
  const clock = new FakeClock();
  let attempts = 0;
  const session = new IdleAutomationSession({
    clock,
    ensureConnection: async () => { attempts += 1; if (attempts === 1) throw new Error("connect ECONNREFUSED 127.0.0.1:62000"); },
    collectState: async () => state(5),
    planState: async () => ({ recommended: { estimatedEnergy: 1 } }),
    runBoundedSession: async () => ({ ok: false, reason: "done" }),
  });
  const running = session.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.pending[0].ms, 5_000);
  clock.advanceOne();
  assert.equal((await running).reason, "done");
  assert.equal(attempts, 2);
});

test("disconnects use bounded low-frequency backoff and always re-read after recovery", async () => {
  const clock = new FakeClock();
  let attempts = 0, reads = 0;
  const session = new IdleAutomationSession({
    clock,
    ensureConnection: async () => { attempts += 1; if (attempts < 3) throw new Error("offline"); },
    collectState: async () => { reads += 1; return state(5); },
    planState: async () => ({ recommended: { estimatedEnergy: 1 } }),
    runBoundedSession: async () => ({ ok: false, reason: "unrecoverable-runtime-block" }),
    connectionBackoffMs: 30_000,
  });
  const running = session.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.pending[0].ms, 30_000);
  clock.advanceOne();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.pending[0].ms, 60_000);
  clock.advanceOne();
  const result = await running;
  assert.equal(result.reason, "unrecoverable-runtime-block");
  assert.equal(reads, 1);
});

test("disconnects during a bounded cycle back off and restart from fresh state and plan", async () => {
  const clock = new FakeClock();
  let reads = 0, plans = 0, runs = 0;
  const session = new IdleAutomationSession({
    clock,
    ensureConnection: async () => {},
    collectState: async () => { reads += 1; return state(5); },
    planState: async () => { plans += 1; return { recommended: { estimatedEnergy: 1 } }; },
    runBoundedSession: async () => { runs += 1; if (runs === 1) throw new Error("CDP WebSocket closed"); return { ok: false, reason: "unrecoverable-runtime-block" }; },
    connectionBackoffMs: 30_000,
  });
  const running = session.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.pending[0].ms, 30_000);
  clock.advanceOne();
  const result = await running;
  assert.equal(result.reason, "unrecoverable-runtime-block");
  assert.equal(reads, 2);
  assert.equal(plans, 2);
  assert.equal(runs, 2);
});

test("connection failure results back off while planning errors terminate", async () => {
  const clock = new FakeClock();
  let runs = 0;
  const session = new IdleAutomationSession({
    clock,
    ensureConnection: async () => {}, collectState: async () => state(5),
    planState: async () => ({ recommended: { estimatedEnergy: 1 } }),
    runBoundedSession: async () => ++runs === 1 ? { ok: false, reason: "atomic_action_error", error: "CDP WebSocket closed" } : { ok: false, reason: "done" },
  });
  const running = session.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.pending[0].ms, 5_000);
  clock.advanceOne();
  assert.equal((await running).reason, "done");

  const brokenPlan = new IdleAutomationSession({
    clock: new FakeClock(), ensureConnection: async () => {}, collectState: async () => state(5),
    planState: async () => { throw new Error("catalog target mismatch"); }, runBoundedSession: async () => ({}),
  });
  await assert.rejects(() => brokenPlan.run(), /catalog target mismatch/);
});

test("node transport error codes enter connection backoff", async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  const session = new IdleAutomationSession({
    clock, ensureConnection: async () => { throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:62000"), { code: "ECONNREFUSED" }); },
    collectState: async () => state(1), planState: async () => ({}), runBoundedSession: async () => ({}),
  });
  const running = session.run({ signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.pending[0].ms, 5_000);
  controller.abort();
  session.interruptWait("stop");
  assert.equal((await running).reason, "aborted");
});

test("pause and stop interrupt an idle timer immediately", async () => {
  const clock = new FakeClock();
  let paused = false;
  const controller = new AbortController();
  const session = new IdleAutomationSession({
    clock,
    ensureConnection: async () => {},
    collectState: async () => state(0),
    planState: async () => ({ recommended: { estimatedEnergy: 5 } }),
    runBoundedSession: async () => ({ ok: true, reason: "complete" }),
    waitIfPaused: async () => { while (paused && !controller.signal.aborted) await new Promise((resolve) => setImmediate(resolve)); },
  });
  const running = session.run({ signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  paused = true;
  session.interruptWait("pause");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.aborted, 1);
  controller.abort();
  session.interruptWait("stop");
  paused = false;
  const result = await running;
  assert.equal(result.reason, "aborted");
});

test("pause and stop interrupt connection preparation immediately", async () => {
  const controller = new AbortController();
  let interrupted = 0;
  const session = new IdleAutomationSession({
    ensureConnection: async (signal) => new Promise((_resolve, reject) => {
      const abort = () => { interrupted += 1; reject(Object.assign(new Error("connection aborted"), { name: "AbortError" })); };
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    }),
    collectState: async () => state(1), planState: async () => ({}), runBoundedSession: async () => ({}),
  });
  const running = session.run({ signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  session.interruptWait("pause");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(interrupted >= 1);
  controller.abort();
  session.interruptWait("stop");
  assert.equal((await running).reason, "aborted");
});

test("an idle waiter can abort a connection promise started by another caller", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-connect-"));
  const runtime = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  let finish;
  runtime.connectOnce = async () => new Promise((resolve) => { finish = resolve; });
  const shared = runtime.connect();
  const controller = new AbortController();
  const waiting = runtime.connect(controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error) => error.name === "AbortError");
  finish({ probe: { context: { id: 1 } } });
  assert.equal((await shared).probe.context.id, 1);
  runtime.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a pre-aborted first caller does not start connection discovery", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-aborted-connect-"));
  const runtime = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  let attempts = 0;
  runtime.connectOnce = async () => { attempts += 1; throw new Error("unexpected"); };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runtime.connect(controller.signal), (error) => error.name === "AbortError");
  assert.equal(attempts, 0);
  assert.equal(runtime.connectPromise, null);
  runtime.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("idle recovery intent is process-local and is not restored into a new scheduler", () => {
  const first = new IdleAutomationSession({ ensureConnection: async () => {}, collectState: async () => state(1), planState: async () => ({}), runBoundedSession: async () => ({}) });
  const restarted = new IdleAutomationSession({ ensureConnection: async () => {}, collectState: async () => state(1), planState: async () => ({}), runBoundedSession: async () => ({}) });
  assert.equal(first.running, false);
  assert.equal(restarted.running, false);
});

test("idle session, wait, action, and termination history persists without recovery intent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-history-"));
  const file = path.join(dir, "automation.db");
  const database = new AutomationDatabase(file);
  const sessionId = database.startSession("idle", { persistence: "process-local" });
  database.logAction({ sessionId, sequence: 1, type: "idle-wait", reason: "energy-recovery", ok: true, details: { delayMs: 60_000 } });
  database.endSession(sessionId, "stopped");
  database.close();
  const reopened = new AutomationDatabase(file);
  const session = reopened.listSessions(1)[0];
  assert.equal(session.mode, "idle");
  assert.equal(session.status, "stopped");
  assert.equal(session.settings.persistence, "process-local");
  assert.equal(reopened.listRecentActions(1)[0].action_type, "idle-wait");
  assert.equal(reopened.getSetting("idle-recovery-intent", null), null);
  reopened.close();
});

test("observation-mode bounded start remains preview-only when omitted or invalid", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "observation-start-"));
  const runtime = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  let execute = null;
  runtime.iconService.waitForIdle = async () => {};
  runtime.connect = async () => {};
  runtime.createRuntime = () => ({ run: async (options) => { execute = options.execute; return { ok: true, reason: "planned" }; } });
  const result = await runtime.start({});
  assert.equal(result.reason, "planned");
  assert.equal(execute, false);
  runtime.saveSettings({ ...runtime.getSettings(), mode: "automatic" });
  await runtime.start({});
  assert.equal(execute, false);
  await runtime.start({ mode: "typo" });
  assert.equal(execute, false);
  runtime.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("bounded automation start does not wait for background icon acquisition", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "start-icon-priority-"));
  const runtime = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  let releaseIcons;
  runtime.iconService.waitForIdle = () => new Promise((resolve) => { releaseIcons = resolve; });
  let interruptions = 0;
  runtime.iconService.interruptForAutomation = () => { interruptions += 1; return 0; };
  runtime.connect = async () => {};
  runtime.createRuntime = () => ({ run: async () => ({ ok: true, reason: "planned", actions: [] }) });
  const startPromise = runtime.start({ mode: "observation" });
  const winner = await Promise.race([startPromise.then(() => "start"), new Promise((resolve) => setTimeout(() => resolve("timeout"), 30))]);
  releaseIcons?.();
  await startPromise;
  assert.equal(winner, "start");
  assert.equal(interruptions, 1);
  runtime.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("stopping during a bounded CDP read completes as aborted instead of automation-error", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-stop-abort-"));
  const runtime = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  runtime.iconService.waitForIdle = async () => {};
  runtime.connect = async () => {};
  runtime.createRuntime = () => ({
    run: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("CDP command aborted"), { name: "AbortError" })), { once: true })),
  });

  const running = runtime.start({ mode: "automatic" });
  await new Promise((resolve) => setImmediate(resolve));
  runtime.stop();
  const result = await running;

  assert.equal(result.reason, "aborted");
  assert.equal(runtime.database.listSessions(1)[0].status, "stopped");
  runtime.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a zero-action bounded session persists its explainable boundary", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-zero-action-"));
  const runtime = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  runtime.iconService.waitForIdle = async () => {};
  runtime.connect = async () => {};
  runtime.createRuntime = () => ({ run: async () => ({ ok: true, executed: true, reason: "waiting-no-feasible-order", actions: [] }) });

  const result = await runtime.start({ mode: "automatic" });
  const boundary = runtime.database.listRecentActions(1)[0];

  assert.equal(result.reason, "waiting-no-feasible-order");
  assert.equal(boundary.action_type, "boundary");
  assert.equal(boundary.reason, "waiting-no-feasible-order");
  runtime.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a bounded automation error persists one diagnostic action without duplicating recorded actions", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-error-history-"));
  const runtime = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  runtime.iconService.waitForIdle = async () => {};
  runtime.connect = async () => {};
  runtime.createRuntime = (_options, sessionId, nextSequence) => ({
    run: async () => {
      runtime.database.logAction({ sessionId, sequence: nextSequence(), type: "merge", reason: "merge-complete", ok: true });
      throw Object.assign(new Error("CDP WebSocket closed"), { code: "CDP_SOCKET_CLOSED" });
    },
  });

  await assert.rejects(runtime.start({ mode: "automatic" }), /CDP WebSocket closed/);
  const session = runtime.database.listSessions(1)[0];
  const actions = runtime.database.listRecentActions(10)
    .filter((action) => Number(action.session_id) === session.id)
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));

  assert.equal(session.status, "error");
  assert.deepEqual(actions.map((action) => action.action_type), ["merge", "error"]);
  assert.equal(actions[1].reason, "automation-error");
  assert.equal(actions[1].ok, 0);
  assert.deepEqual(JSON.parse(actions[1].details_json), {
    message: "CDP WebSocket closed",
    code: "CDP_SOCKET_CLOSED",
  });
  runtime.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("an idle automation error persists its message and code", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-error-history-"));
  const runtime = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  runtime.connect = async () => {};
  runtime.collectState = async () => {
    throw Object.assign(new Error("catalog target mismatch"), { code: "CATALOG_TARGET_MISMATCH" });
  };

  await assert.rejects(runtime.startIdle({ mode: "automatic" }), /catalog target mismatch/);
  const session = runtime.database.listSessions(1)[0];
  const actions = runtime.database.listRecentActions(10).filter((action) => Number(action.session_id) === session.id);

  assert.equal(session.status, "error");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action_type, "error");
  assert.equal(actions[0].reason, "automation-error");
  assert.equal(actions[0].ok, 0);
  assert.deepEqual(JSON.parse(actions[0].details_json), {
    message: "catalog target mismatch",
    code: "CATALOG_TARGET_MISMATCH",
  });
  runtime.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("background start defers heavy runtime work until after the accepted response", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "background-start-deferred-"));
  const runtime = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  let started = false;
  runtime.start = async () => { started = true; return { ok: true, reason: "done" }; };

  const accepted = runtime.startInBackground({ mode: "automatic" });

  assert.equal(accepted.accepted, true);
  assert.equal(started, false);
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.activeRunPromise;
  assert.equal(started, true);
  runtime.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("idle runtime and scheduler events share one monotonic action sequence", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-sequence-"));
  const runtime = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  runtime.selection = { probe: { context: { id: 1 } } };
  runtime.lab = { client: {} };
  const sessionId = runtime.database.startSession("idle", {});
  let sequence = 1;
  const loop = runtime.createRuntime({ mode: "assisted" }, sessionId, () => ++sequence);
  runtime.database.logAction({ sessionId, sequence: 1, type: "idle-wait" });
  loop.onEvent({ type: "merge", ok: true });
  loop.onEvent({ type: "submit-order", ok: true });
  const actions = runtime.database.listRecentActions(3).sort((left, right) => left.sequence - right.sequence);
  assert.deepEqual(actions.map((action) => action.sequence), [1, 2, 3]);
  runtime.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("stop aborts an executor settle wait before post-action reads", async () => {
  const controller = new AbortController();
  let reads = 0;
  const submitter = new OrderSubmitter({
    client: { evaluate: async () => { controller.abort(); return { ok: true }; } },
    contextId: 1,
    collectState: async () => {
      reads += 1;
      return { orders: [{ slot: "1", taskId: "a", ready: true }], resources: { coins: 1 } };
    },
    settleMs: 5_000,
  });
  const result = await submitter.submit("1", { execute: true, signal: controller.signal });
  assert.equal(result.reason, "aborted");
  assert.equal(reads, 1);
});

test("CDP evaluation abort removes the pending command immediately", async () => {
  const client = new CdpClient({ timeoutMs: 10_000 });
  client.socket = { readyState: 1, send: () => {} };
  const controller = new AbortController();
  const evaluating = client.evaluate("1", 1, { signal: controller.signal });
  controller.abort();
  await assert.rejects(evaluating, (error) => error.name === "AbortError");
  assert.equal(client.pending.size, 0);
});

test("warehouse abort after native acknowledgement invalidates stale knowledge", async () => {
  const controller = new AbortController();
  const invalidations = [];
  const executor = new WarehouseActionExecutor({
    client: { evaluate: async () => { controller.abort(); return { ok: true }; } }, contextId: 1,
    collectState: async () => ({ scene: "board", board: { grids: [] }, resources: {}, orders: [] }),
    settleMs: 5_000, onInventoryKnowledgeInvalidated: (reason) => invalidations.push(reason),
  });
  const preflight = { ok: true, before: { board: { signature: "x" } }, source: { itemId: "x" }, storeAvailability: { targetSlotId: "w1", itemId: "x", boardSignature: "x" } };
  const stored = await executor.move(0, { execute: true, signal: controller.signal, preflight });
  assert.equal(stored.resyncRequired, true);
  assert.match(invalidations[0], /pending-resynchronization/);

  const retrieveController = new AbortController();
  const retrieveInvalidations = [];
  const retriever = new WarehouseActionExecutor({
    client: { evaluate: async () => { retrieveController.abort(); return { ok: true }; } }, contextId: 1,
    collectState: async () => ({ board: { grids: [] }, resources: {}, orders: [] }), settleMs: 5_000,
    onInventoryKnowledgeInvalidated: (reason) => retrieveInvalidations.push(reason),
  });
  const inventory = { status: "loaded", revision: "r1", retrievalPath: { status: "trusted" }, slots: [{ slotId: "w1", occupied: true, itemId: "x" }] };
  const retrieved = await retriever.retrieve({ warehouseSlotId: "w1", itemId: "x", inventoryRevision: "r1" }, { execute: true, signal: retrieveController.signal, inventory });
  assert.equal(retrieved.resyncRequired, true);
  assert.match(retrieveInvalidations[0], /pending-resynchronization/);
});

test("warehouse abort while native mutation is in flight marks its outcome uncertain", async () => {
  const controller = new AbortController();
  const invalidations = [];
  const executor = new WarehouseActionExecutor({
    client: { evaluate: async (_expression, _contextId, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("CDP command aborted"), { name: "AbortError" })), { once: true })) },
    contextId: 1, collectState: async () => ({}), settleMs: 5_000,
    onInventoryKnowledgeInvalidated: (reason) => invalidations.push(reason),
  });
  const preflight = { ok: true, before: { board: { signature: "x" } }, source: { itemId: "x" }, storeAvailability: { targetSlotId: "w1", itemId: "x", boardSignature: "x" } };
  const moving = executor.move(0, { execute: true, signal: controller.signal, preflight });
  controller.abort();
  const result = await moving;
  assert.equal(result.reason, "warehouse-store-outcome-unknown");
  assert.equal(result.resyncRequired, true);
  assert.deepEqual(invalidations, ["warehouse-store-outcome-unknown"]);
});

test("runtime state collection forwards cancellation into snapshots", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-abort-"));
  const runtime = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  const selection = { probe: { context: { id: 1 } } };
  const controller = new AbortController();
  let forwardedSignal = null;
  let closed = 0;
  runtime.connect = async () => selection;
  const lab = runtime.lab = {
    snapshot: async (_selection, options) => new Promise((_resolve, reject) => {
      forwardedSignal = options.signal;
      if (options.signal.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }),
    close: async () => { closed += 1; },
  };
  runtime.selection = selection;
  const collecting = runtime.collectState(controller.signal);
  controller.abort();
  await assert.rejects(collecting, (error) => error.name === "AbortError");
  assert.equal(forwardedSignal, controller.signal);
  assert.equal(closed, 0);
  assert.equal(runtime.lab, lab);
  assert.equal(runtime.selection, selection);
  runtime.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
