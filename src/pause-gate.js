"use strict";

class PauseGate {
  constructor({ onBoundaryReached = null } = {}) {
    this.paused = false;
    this.boundaryReached = false;
    this.onBoundaryReached = onBoundaryReached;
    this.waiters = new Set();
    this.boundaryWaiters = new Set();
  }
  pause() { this.paused = true; this.boundaryReached = false; return { ok: true, paused: true }; }
  resume() { this.paused = false; this.boundaryReached = false; for (const resolve of this.waiters) resolve(); for (const resolve of this.boundaryWaiters) resolve(); this.waiters.clear(); this.boundaryWaiters.clear(); return { ok: true, paused: false }; }
  reset() { return this.resume(); }
  waitForBoundary() {
    if (!this.paused || this.boundaryReached) return Promise.resolve();
    return new Promise((resolve) => this.boundaryWaiters.add(resolve));
  }
  async wait(signal = null) {
    if (!this.paused) return;
    if (signal?.aborted) return;
    if (!this.boundaryReached) {
      this.boundaryReached = true;
      this.onBoundaryReached?.();
    }
    for (const resolve of this.boundaryWaiters) resolve();
    this.boundaryWaiters.clear();
    await new Promise((resolve) => {
      const done = () => { signal?.removeEventListener?.("abort", aborted); this.waiters.delete(done); resolve(); };
      const aborted = () => { this.waiters.delete(done); resolve(); };
      this.waiters.add(done);
      signal?.addEventListener?.("abort", aborted, { once: true });
    });
  }
}

module.exports = { PauseGate };
