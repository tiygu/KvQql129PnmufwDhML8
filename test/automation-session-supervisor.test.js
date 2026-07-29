"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { AutomationSessionSupervisor } = require("../src/automation-session-supervisor");

function fixture() {
  const sessions = [];
  const ended = [];
  const database = {
    startSession(kind, options) {
      const id = sessions.length + 1;
      sessions.push({ id, kind, options });
      return id;
    },
    endSession(id, status) {
      ended.push({ id, status });
    },
  };
  return { database, sessions, ended };
}

test("only one bounded or idle session can reserve the supervisor", () => {
  const f = fixture();
  const supervisor = new AutomationSessionSupervisor(f);
  const first = supervisor.reserveSession("bounded", { mode: "automatic" });
  const second = supervisor.reserveSession("idle");
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "already-running");
  supervisor.stop();
  supervisor.finish();
  assert.deepEqual(f.ended, [{ id: 1, status: "complete" }]);
});

test("background execution records one terminal session and exposes a complete status snapshot", async () => {
  const f = fixture();
  const statuses = [];
  const supervisor = new AutomationSessionSupervisor({
    ...f,
    onEvent: (type, snapshot) => {
      if (type === "automation-status") statuses.push(snapshot);
    },
  });
  const accepted = supervisor.startInBackground(async (signal, sessionId) => {
    assert.equal(signal.aborted, false);
    assert.equal(sessionId, 1);
    return { ok: true, reason: "complete" };
  }, "idle", { persistence: "process-local" });
  assert.equal(accepted.accepted, true);
  await supervisor.backgroundPromise;
  assert.deepEqual(f.ended, [{ id: 1, status: "complete" }]);
  assert.ok(statuses.every((snapshot) => "statusRevision" in snapshot && "safeBoundaryAvailable" in snapshot));
});

test("start synchronously returns a foreground receipt with rejecting completion", async () => {
  const f = fixture();
  const supervisor = new AutomationSessionSupervisor(f);
  const receipt = supervisor.start({
    kind: "bounded",
    delivery: "foreground",
    run: async () => {
      throw new Error("foreground failed");
    },
  });
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.delivery, "foreground");
  assert.equal(typeof receipt.completion?.then, "function");
  await assert.rejects(receipt.completion, /foreground failed/);
  assert.deepEqual(f.ended, [{ id: 1, status: "error" }]);
});

test("exclusive boundary is acquired before work, released in finally, and permits paused scans", async () => {
  const f = fixture();
  const supervisor = new AutomationSessionSupervisor(f);
  const release = supervisor.beginBoundary("sale");
  assert.equal(supervisor.snapshot().boundaryOwner, "sale");
  assert.equal(supervisor.beginBoundary("map"), null);
  release();
  const reserved = supervisor.reserveSession("bounded");
  assert.equal(supervisor.beginBoundary("scan"), null);
  supervisor.pause();
  const result = await supervisor.withBoundary("scan", async () => "done", { allowPaused: true });
  assert.equal(result, "done");
  supervisor.stop();
  supervisor.finish();
  assert.equal(supervisor.snapshot().safeBoundaryAvailable, true);
});

test("prepared stop propagates abort and status revisions are monotonic", () => {
  const f = fixture();
  const supervisor = new AutomationSessionSupervisor(f);
  const revisions = [];
  supervisor.on("status", (snapshot) => revisions.push(snapshot.statusRevision));
  const reservation = supervisor.reserveSession("bounded");
  supervisor.pause();
  const stopped = supervisor.stop();
  assert.equal(stopped.alreadyStopped, false);
  assert.equal(reservation.signal.aborted, true);
  assert.ok(revisions.every((value, index) => index === 0 || value > revisions[index - 1]));
  supervisor.finish();
});

test("pause-requested becomes paused only when the strategy reaches the pause gate", async () => {
  const f = fixture();
  const supervisor = new AutomationSessionSupervisor(f);
  const reservation = supervisor.reserveSession("bounded");
  supervisor.pause();
  assert.equal(supervisor.snapshot().phase, "pause-requested");
  assert.equal(supervisor.snapshot().safeBoundaryReached, false);
  const waiting = supervisor.pauseGate.wait(reservation.signal);
  assert.equal(supervisor.snapshot().phase, "paused");
  assert.equal(supervisor.snapshot().safeBoundaryReached, true);
  supervisor.resume();
  await waiting;
  supervisor.stop();
  supervisor.finish();
});

test("session finalization preserves an independently held boundary lease", () => {
  const f = fixture();
  const supervisor = new AutomationSessionSupervisor(f);
  supervisor.reserveSession("bounded");
  supervisor.pause();
  const release = supervisor.beginBoundary("scan", { allowPaused: true });
  supervisor.endSession("complete");
  supervisor.finish();
  assert.equal(supervisor.snapshot().boundaryBusy, true);
  assert.equal(supervisor.snapshot().safeBoundaryAvailable, false);
  release();
  assert.equal(supervisor.snapshot().boundaryBusy, false);
  assert.equal(supervisor.snapshot().safeBoundaryAvailable, true);
});

test("runtime delegates session fields and boundary admission to the supervisor", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "automation-runtime.js"),
    "utf8",
  );
  for (const field of [
    "running",
    "sessionKind",
    "activeSessionId",
    "activeRunPromise",
    "abortController",
    "idleSession",
    "actionBoundaryPending",
  ]) {
    assert.doesNotMatch(source, new RegExp(`this\\.${field}\\s*=(?!=)`));
  }
  assert.match(source, /beginActionBoundary\(/);
  assert.match(source, /automationStatus:\s*this\.sessionSupervisor\.snapshot\(\)/);
  const bounded = source.slice(source.indexOf("async start(options"), source.indexOf("startInBackground(options"));
  const idle = source.slice(source.indexOf("async startIdle(options"), source.indexOf("startIdleInBackground(options"));
  for (const strategy of [bounded, idle]) {
    assert.match(strategy, /sessionSupervisor\.runReserved/);
    assert.doesNotMatch(strategy, /sessionSupervisor\.(?:endSession|finish)/);
  }
  const idleBackgroundStart = source.indexOf("startIdleInBackground(options");
  const background = [
    source.slice(source.indexOf("startInBackground(options"), source.indexOf("async startIdle(options")),
    source.slice(idleBackgroundStart, source.indexOf("\n  stop()", idleBackgroundStart)),
  ].join("\n");
  assert.equal((background.match(/sessionSupervisor\.trackBackground/g) || []).length, 2);
  assert.doesNotMatch(background, /this\.emit\("automation-(?:complete|error)"/);
  const supervisorSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "automation-session-supervisor.js"),
    "utf8",
  );
  assert.match(supervisorSource, /safeBoundaryReached/);
});

test("background failures are contained and record one diagnostic and terminal status", async () => {
  const f = fixture();
  const actions = [];
  f.database.logAction = (action) => actions.push(action);
  const events = [];
  const supervisor = new AutomationSessionSupervisor({
    ...f,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const receipt = supervisor.start({
    kind: "bounded",
    delivery: "background",
    run: async () => {
      throw Object.assign(new Error("boom"), { code: "BOOM" });
    },
  });
  const result = await receipt.completion;
  assert.equal(result.reason, "automation-error");
  assert.deepEqual(f.ended, [{ id: 1, status: "error" }]);
  assert.equal(actions.length, 1);
  assert.equal(events.filter((event) => event.type === "automation-error").length, 1);
});

test("close drains an active boundary, is idempotent, and rejects later claims", async () => {
  const f = fixture();
  const events = [];
  const supervisor = new AutomationSessionSupervisor({
    ...f,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const release = supervisor.beginBoundary("scan");
  let closed = false;
  const closing = supervisor.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await closing;
  const revision = supervisor.snapshot().statusRevision;
  await supervisor.close();
  assert.equal(supervisor.snapshot().statusRevision, revision);
  assert.equal(supervisor.reserveSession("bounded").accepted, false);
  assert.equal(supervisor.beginBoundary("late"), null);
  const eventCount = events.length;
  await supervisor.trackBackground(Promise.reject(new Error("late")));
  assert.equal(events.length, eventCount);
});
