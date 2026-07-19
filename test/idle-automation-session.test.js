"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IdleAutomationSession, computeEnergyWakeDelay } = require("../src/idle-automation-session");
const { AutomationDatabase } = require("../src/automation-database");

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
