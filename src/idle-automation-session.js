"use strict";

const { setTimeout: delay } = require("node:timers/promises");

const DEFAULT_CONNECTION_BACKOFF_MS = 30_000;
const MAX_CONNECTION_BACKOFF_MS = 5 * 60_000;
const DEFAULT_RECOVERY_POLL_MS = 60_000;

function timestampMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 1_000_000_000_000 ? number * 1000 : number;
}

function computeEnergyWakeDelay(state, { requiredEnergy = 1, now = Date.now() } = {}) {
  const current = Number(state.energy?.amount ?? state.resources?.energy);
  const limit = Number(state.energy?.limit);
  const requested = Math.max(0, Number(requiredEnergy) || 0);
  const required = Number.isFinite(limit) && limit > 0 ? Math.min(limit, requested) : requested;
  if (Number.isFinite(current) && current >= required) return 0;
  const intervalMs = Number(state.energy?.recoverIntervalSeconds) * 1000;
  if (!Number.isFinite(current) || !(intervalMs > 0)) return DEFAULT_RECOVERY_POLL_MS;
  const ticks = Math.max(1, Math.ceil(required - current));
  const reportedNext = timestampMs(state.energy?.recoverTimestamp);
  const nextRecovery = reportedNext != null && reportedNext > now ? reportedNext : now + intervalMs;
  return Math.max(1, nextRecovery + (ticks - 1) * intervalMs - now);
}

function requiredEnergyFromPlan(plan, state) {
  const actionType = plan?.recommended?.nextAction?.type;
  if (["merge", "retrieve-from-warehouse", "store-to-warehouse", "submit-order", "switch-production-mode"].includes(actionType)) return 0;
  const actionEnergy = Number(plan?.recommended?.nextAction?.energyCost);
  const estimated = Number(plan?.recommended?.estimatedEnergy);
  const limit = Number(state.energy?.limit);
  const required = Number.isFinite(actionEnergy) && actionEnergy > 0 ? actionEnergy : Number.isFinite(estimated) && estimated > 0 ? estimated : 1;
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, required) : required;
}

function defaultClock() {
  return { now: () => Date.now(), sleep: (ms, signal) => delay(ms, null, signal ? { signal } : undefined) };
}

class IdleAutomationSession {
  constructor({ ensureConnection, collectState, planState, runBoundedSession, waitIfPaused = null, onEvent = null, clock = defaultClock(), connectionBackoffMs = DEFAULT_CONNECTION_BACKOFF_MS }) {
    this.ensureConnection = ensureConnection;
    this.collectState = collectState;
    this.planState = planState;
    this.runBoundedSession = runBoundedSession;
    this.waitIfPaused = waitIfPaused;
    this.onEvent = onEvent;
    this.clock = clock;
    this.connectionBackoffMs = Math.max(5_000, Number(connectionBackoffMs) || DEFAULT_CONNECTION_BACKOFF_MS);
    this.running = false;
    this.waitController = null;
    this.waitReason = null;
  }

  interruptWait(reason = "interrupted") {
    this.waitReason = String(reason);
    this.waitController?.abort();
  }

  async sleep(ms, externalSignal, detail) {
    const controller = new AbortController();
    this.waitController = controller;
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    this.onEvent?.({ type: "idle-wait", delayMs: ms, ...detail });
    try {
      await this.clock.sleep(ms, controller.signal);
      return true;
    } catch (error) {
      if (error?.name !== "AbortError") throw error;
      return false;
    } finally {
      externalSignal?.removeEventListener("abort", abort);
      if (this.waitController === controller) this.waitController = null;
    }
  }

  async run({ signal = null } = {}) {
    if (this.running) return { ok: false, reason: "idle-session-already-running" };
    this.running = true;
    let backoff = this.connectionBackoffMs;
    let cycles = 0;
    try {
      while (!signal?.aborted) {
        await this.waitIfPaused?.(signal);
        if (signal?.aborted) break;
        let state, plan;
        try {
          await this.ensureConnection();
          state = await this.collectState();
          plan = await this.planState(state);
          backoff = this.connectionBackoffMs;
        } catch (error) {
          this.onEvent?.({ type: "idle-connection-backoff", error: error.message, delayMs: backoff });
          await this.sleep(backoff, signal, { reason: "connection-backoff" });
          backoff = Math.min(MAX_CONNECTION_BACKOFF_MS, backoff * 2);
          continue;
        }
        const requiredEnergy = requiredEnergyFromPlan(plan, state);
        const wakeDelay = computeEnergyWakeDelay(state, { requiredEnergy, now: this.clock.now() });
        if (wakeDelay > 0) {
          await this.sleep(wakeDelay, signal, { reason: "energy-recovery", energy: Number(state.energy?.amount ?? state.resources?.energy), requiredEnergy, recoverAt: this.clock.now() + wakeDelay });
          continue;
        }
        const result = await this.runBoundedSession({ signal, freshState: state, freshPlan: plan });
        cycles += 1;
        this.onEvent?.({ type: "idle-cycle-complete", cycle: cycles, reason: result.reason, ok: result.ok });
        if (signal?.aborted) break;
        if (result.reason === "order-completed" || result.reason === "energy-depleted" || result.reason === "waiting-insufficient-energy") continue;
        return { ...result, idle: true, cycles };
      }
      return { ok: true, idle: true, reason: "aborted", cycles };
    } finally {
      this.running = false;
      this.waitController = null;
    }
  }
}

module.exports = { IdleAutomationSession, computeEnergyWakeDelay, requiredEnergyFromPlan };
