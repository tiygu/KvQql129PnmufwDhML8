"use strict";

const { EventEmitter } = require("node:events");
const { PauseGate } = require("./pause-gate");

function abortError(message = "operation aborted") {
  return Object.assign(new Error(message), { name: "AbortError", code: "ABORT_ERR" });
}

/**
 * Owns automation-session lifecycle state and exclusive safe-boundary leases.
 * Runtime strategies remain responsible for domain actions; they receive only
 * the reserved session context and abort signal from this seam.
 */
class AutomationSessionSupervisor extends EventEmitter {
  constructor({ database, pauseGate, onEvent = null, clock = () => Date.now() } = {}) {
    super();
    this.database = database;
    this.pauseGate = pauseGate || new PauseGate();
    this.pauseGate.onBoundaryReached = () => this.markPauseBoundaryReached();
    this.onEvent = onEvent;
    this.clock = clock;
    this.running = false;
    this.paused = false;
    this.sessionKind = null;
    this.sessionId = null;
    this.abortController = null;
    this.backgroundPromise = null;
    this.idleSession = null;
    this.boundaryOwner = null;
    this.boundaryBusy = false;
    this.safeBoundaryReached = false;
    this.boundaryWaiters = new Set();
    this.statusRevision = 0;
    this.terminalRecorded = false;
    this.actionSequence = 0;
    this.closing = false;
    this.closed = false;
    this.phase = "idle";
  }

  snapshot() {
    return Object.freeze({
      statusRevision: this.statusRevision,
      phase: this.closed ? "closed" : this.closing ? "closing" : this.phase,
      running: this.running,
      paused: this.paused,
      sessionKind: this.sessionKind,
      sessionId: this.sessionId,
      boundaryBusy: this.boundaryBusy,
      boundaryOwner: this.boundaryOwner,
      safeBoundaryReached: this.safeBoundaryReached,
      safeBoundaryAvailable: !this.running && !this.boundaryBusy,
    });
  }

  publish(extra = {}) {
    if (this.closed) return this.snapshot();
    const next = this.nextSnapshot(extra);
    this.emit("status", next);
    this.onEvent?.("automation-status", next);
    return next;
  }

  nextSnapshot(extra = {}) {
    if (this.closed) return this.snapshot();
    this.statusRevision += 1;
    return Object.freeze({
      ...this.snapshot(),
      ...extra,
      statusRevision: this.statusRevision,
    });
  }

  reserveSession(kind, options = {}) {
    if (this.closing || this.closed || this.running || this.boundaryBusy || this.backgroundPromise) {
      return { accepted: false, ok: true, reason: "already-running", sessionId: this.sessionId };
    }
    this.abortController = new AbortController();
    this.sessionKind = String(kind);
    this.sessionId = this.database?.startSession?.(this.sessionKind, options) ?? null;
    this.running = true;
    this.phase = "running";
    this.paused = false;
    this.terminalRecorded = false;
    this.publish();
    return {
      accepted: true,
      ok: true,
      reason: "automation-started",
      sessionId: this.sessionId,
      signal: this.abortController.signal,
      controller: this.abortController,
    };
  }

  start({ kind = "bounded", options = {}, delivery = "foreground", run } = {}) {
    const receipt = this.reserveSession(kind, options);
    if (!receipt.accepted) return receipt;
    const completion = this.runReserved(run || (async () => ({ ok: true, reason: "complete" })));
    if (delivery === "background") {
      return { ...receipt, delivery, completion: this.trackBackground(completion) };
    }
    return { ...receipt, delivery: "foreground", completion };
  }

  beginStarting(kind, options = {}) {
    if (this.closing || this.closed || this.running || this.boundaryBusy) {
      return { accepted: false, ok: true, reason: "already-running", sessionId: this.sessionId };
    }
    this.abortController = new AbortController();
    this.sessionKind = String(kind);
    this.sessionId = this.database?.startSession?.(
      options.sessionDatabaseKind || this.sessionKind,
      options,
    ) ?? null;
    this.running = true;
    this.phase = "starting";
    this.paused = false;
    this.publish({ options });
    return { accepted: true, ok: true, signal: this.abortController.signal, controller: this.abortController };
  }

  attachSession(sessionId) {
    this.sessionId = sessionId ?? null;
    this.phase = "running";
    this.terminalRecorded = false;
    this.publish();
    return this.snapshot();
  }

  failStart(error = null) {
    if (this.sessionId != null && error) {
      this.database?.logAction?.({
        sessionId: this.sessionId,
        sequence: 1,
        type: "error",
        reason: "automation-error",
        ok: false,
        details: { message: error.message || String(error), code: error.code || null },
      });
    }
    this.endSession("error");
    this.phase = "failed";
    this.publish();
    this.finish();
  }

  setIdleSession(session) {
    this.idleSession = session;
  }

  setBackgroundPromise(promise) {
    this.backgroundPromise = promise;
  }

  adoptSession({ kind, sessionId, abortController, running = true, paused = false } = {}) {
    this.sessionKind = kind == null ? null : String(kind);
    this.sessionId = sessionId ?? null;
    this.abortController = abortController || new AbortController();
    this.running = !!running;
    this.paused = !!paused;
    this.terminalRecorded = true;
    this.publish();
    return this.snapshot();
  }

  async runReserved(run, {
    onError = null,
    onFinally = null,
    terminalStatus = null,
  } = {}) {
    if (!this.running || !this.abortController) throw new Error("no active automation session");
    let result;
    try {
      result = await run(this.abortController.signal, this.sessionId);
      this.endSession(terminalStatus || (result?.reason === "aborted" ? "stopped" : result?.ok ? "complete" : "failed"));
      return result;
    } catch (error) {
      if (onError) onError(error, this.sessionId);
      else this.recordAction({
        type: "error",
        reason: "automation-error",
        ok: false,
        details: { message: error.message || String(error), code: error.code || null },
      });
      this.endSession("error");
      throw error;
    } finally {
      try {
        await onFinally?.();
      } finally {
        this.finish();
      }
    }
  }

  trackBackground(completion) {
    if (this.closing || this.closed) {
      return Promise.resolve(completion).catch((error) => ({
        ok: false,
        reason: "automation-error",
        error: error.message || String(error),
      }));
    }
    const tracked = Promise.resolve(completion)
      .then((result) => {
        this.onEvent?.("automation-complete", { result });
        return result;
      })
      .catch((error) => {
        const result = {
          ok: false,
          reason: "automation-error",
          error: error.message || String(error),
        };
        this.onEvent?.("automation-error", result);
        return result;
      })
      .finally(() => {
        if (this.backgroundPromise === tracked) this.backgroundPromise = null;
      });
    this.backgroundPromise = tracked;
    return tracked;
  }

  startInBackground(run, kind, options = {}) {
    const reservation = this.reserveSession(kind, options);
    if (!reservation.accepted) return reservation;
    this.trackBackground(Promise.resolve()
      .then(() => this.runReserved(run))
    );
    return { ...reservation, reason: "automation-started" };
  }

  beginBoundary(owner, { allowPaused = false } = {}) {
    if (this.closing || this.closed || this.boundaryBusy || (this.running && !(allowPaused && this.paused))) return null;
    this.boundaryBusy = true;
    this.boundaryOwner = String(owner);
    this.publish();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.boundaryBusy = false;
      this.boundaryOwner = null;
      this.publish();
      for (const resolve of this.boundaryWaiters) resolve();
      this.boundaryWaiters.clear();
    };
  }

  async withBoundary(owner, fn, options = {}) {
    const release = this.beginBoundary(owner, options);
    if (!release) return { ok: false, executed: false, reason: "automation-action-boundary-busy" };
    try {
      return await fn();
    } finally {
      release();
    }
  }

  withSafeBoundary(owner, work, options = {}) {
    return this.withBoundary(owner, work, options);
  }

  waitForBoundaryDrain() {
    if (!this.boundaryBusy) return Promise.resolve();
    return new Promise((resolve) => this.boundaryWaiters.add(resolve));
  }

  pause() {
    if (!this.running) return { ok: false, reason: "automation-not-running", paused: false };
    this.phase = "pause-requested";
    this.safeBoundaryReached = false;
    this.publish();
    this.pauseGate?.pause?.();
    this.paused = true;
    this.publish();
    return { ok: true, paused: true };
  }

  markPauseBoundaryReached() {
    if (!this.running || !this.paused || this.safeBoundaryReached) return this.snapshot();
    this.safeBoundaryReached = true;
    this.phase = "paused";
    return this.publish();
  }

  resume() {
    if (!this.running) return { ok: false, reason: "automation-not-running", paused: false };
    if (this.boundaryBusy) return { ok: false, reason: "safe-boundary-task-running", paused: true };
    this.pauseGate?.resume?.();
    this.paused = false;
    this.safeBoundaryReached = false;
    this.phase = "running";
    this.publish();
    return { ok: true, paused: false };
  }

  stop() {
    if (!this.abortController) return { ok: true, alreadyStopped: true };
    this.pauseGate?.resume?.();
    this.abortController.abort(abortError("automation stopped"));
    this.paused = false;
    this.safeBoundaryReached = false;
    this.phase = "stopping";
    this.publish({ reason: "stopped" });
    return { ok: true, alreadyStopped: false };
  }

  endSession(status) {
    if (this.terminalRecorded) return;
    this.terminalRecorded = true;
    if (this.sessionId != null) this.database?.endSession?.(this.sessionId, status);
  }

  recordAction({ type, reason = null, ok = null, details = null } = {}) {
    this.actionSequence += 1;
    this.database?.logAction?.({
      sessionId: this.sessionId,
      sequence: this.actionSequence,
      type,
      reason,
      ok,
      details,
    });
    return this.actionSequence;
  }

  finish() {
    if (this.closed) return this.snapshot();
    this.endSession("complete");
    this.running = false;
    this.paused = false;
    this.abortController = null;
    this.idleSession = null;
    this.sessionId = null;
    this.sessionKind = null;
    this.safeBoundaryReached = false;
    this.phase = this.closing ? "closed" : "idle";
    this.publish();
  }

  async close() {
    if (this.closed) return this.snapshot();
    this.closing = true;
    this.phase = "closing";
    this.stop();
    await this.backgroundPromise?.catch(() => {});
    await this.waitForBoundaryDrain();
    this.finish();
    this.closing = false;
    this.phase = "closed";
    this.publish();
    this.closed = true;
    return this.snapshot();
  }
}

module.exports = { AutomationSessionSupervisor, abortError };
