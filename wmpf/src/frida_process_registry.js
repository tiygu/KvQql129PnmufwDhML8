"use strict";

class FridaProcessRegistry {
    constructor(options = {}) {
        this.now = options.now || Date.now;
        this.backoffMs = options.backoffMs || [2000, 5000, 15000, 60000];
        this.states = new Map();
    }

    beginAttach(pid) {
        const key = Number(pid);
        const state = this.states.get(key);
        if (state && (state.status === "attaching" || state.status === "attached")) return false;
        if (state && state.nextRetryAt > this.now()) return false;
        this.states.set(key, { ...state, pid: key, status: "attaching", nextRetryAt: 0 });
        return true;
    }

    markAttached(pid, value) {
        const key = Number(pid);
        this.states.set(key, { pid: key, status: "attached", attempts: 0, nextRetryAt: 0, ...value });
        return this.states.get(key);
    }

    markFailed(pid, error) {
        const key = Number(pid);
        const previous = this.states.get(key);
        const attempts = (previous && previous.attempts || 0) + 1;
        const delayMs = this.backoffMs[Math.min(attempts - 1, this.backoffMs.length - 1)];
        const state = { pid: key, status: "failed", attempts, nextRetryAt: this.now() + delayMs, error };
        this.states.set(key, state);
        return { ...state, delayMs, shouldLog: attempts === 1 || delayMs !== this.backoffMs[Math.min(attempts - 2, this.backoffMs.length - 1)] };
    }

    detach(pid) { this.states.delete(Number(pid)); }
    get(pid) { return this.states.get(Number(pid)); }
    removeMissing(livePids) {
        for (const pid of this.states.keys()) if (!livePids.has(pid)) this.states.delete(pid);
    }
    attachedEntries() { return [...this.states.values()].filter((state) => state.status === "attached"); }
}

module.exports = { FridaProcessRegistry };
