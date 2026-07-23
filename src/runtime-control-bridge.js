"use strict";

const { summarizeSnapshot } = require("../scripts/summarize-target-snapshot.cjs");
const { BOARD_SCAN_EXPRESSION } = require("./board-automation");
const { buildGameState } = require("./game-state");
const { BoardAutomationRunner } = require("./board-runner");
const { OrderSubmitter } = require("./order-actions");
const { MapMissionCompleter } = require("./map-actions");
const { SceneNavigator } = require("./scene-navigation");
const { WarehouseActionExecutor } = require("./warehouse-actions");
const { ProductionModeExecutor } = require("./production-mode-actions");

/**
 * Runtime Semantic Control Bridge interface implemented by both adapters.
 *
 * @typedef {object} RuntimeSemanticControlBridge
 * @property {(signal?: AbortSignal | null) => Promise<object>} ready
 * @property {(signal?: AbortSignal | null) => Promise<object>} readState
 * @property {(command: object, request?: { signal?: AbortSignal | null, options?: object }) => Promise<object>} execute
 */

function abortError() {
  return Object.assign(new Error("runtime control operation aborted"), { name: "AbortError", code: "ABORT_ERR" });
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function cloneRecord(value) {
  return value == null ? value : structuredClone(value);
}

function waitForAbortable(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => { cleanup(); resolve(result); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

async function resolveFakeEntry(entry, context) {
  assertNotAborted(context.signal);
  const pending = typeof entry === "function" ? entry(context) : entry;
  const value = await waitForAbortable(pending, context.signal);
  assertNotAborted(context.signal);
  if (value instanceof Error) throw value;
  return cloneRecord(value);
}

/**
 * Legacy Adapter for the Runtime Semantic Control Bridge interface.
 * Runtime-specific discovery and atomic executors stay behind this seam.
 */
class LegacyRuntimeControlAdapter {
  constructor({ lab, selection, collectState, onWarehouseInventoryInvalidated = null }) {
    this.lab = lab;
    this.selection = selection;
    this.collectState = collectState;
    this.onWarehouseInventoryInvalidated = onWarehouseInventoryInvalidated;
  }

  async ready(signal = null) {
    assertNotAborted(signal);
    return {
      adapterId: "legacy-cdp",
      contextId: this.selection.probe.context.id,
      capabilities: ["state", "board", "order", "navigation", "map-mission", "warehouse", "production-mode"],
    };
  }

  async readState(signal = null) {
    const snapshot = await this.lab.snapshot(this.selection, { signal });
    let boardState = null;
    try {
      boardState = await this.lab.client.evaluate(BOARD_SCAN_EXPRESSION, this.selection.probe.context.id, { signal });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
    }
    return buildGameState({ state: summarizeSnapshot(snapshot), boardState });
  }

  async execute(command, { signal = null, options = {} } = {}) {
    assertNotAborted(signal);
    if (!command?.type) throw Object.assign(new Error("runtime control command type is required"), { code: "RUNTIME_CONTROL_COMMAND_INVALID" });
    const contextId = this.selection.probe.context.id;
    const collectState = (nextSignal = null) => this.collectState(nextSignal);
    const settleMs = options.settleMs;
    const evaluateTimeoutMs = options.timeoutMs;

    if (command.type === "run-board-action") {
      const runner = new BoardAutomationRunner({
        client: this.lab.client,
        contextId,
        delayMs: options.delayMs,
        evaluateTimeoutMs,
      });
      return runner.run({ producer: command.producer, merge: command.merge, plannedAction: command.plannedAction, maxActions: 1, execute: true, signal });
    }
    if (command.type === "submit-order") {
      const submitter = new OrderSubmitter({ client: this.lab.client, contextId, collectState, settleMs, evaluateTimeoutMs });
      return submitter.submit(command.slot, { execute: true, signal, before: command.before });
    }
    if (command.type === "navigate") {
      const navigator = new SceneNavigator({ client: this.lab.client, contextId, settleMs, evaluateTimeoutMs });
      return navigator.go(command.target, { execute: true, signal });
    }
    if (command.type === "complete-map-mission") {
      const completer = new MapMissionCompleter({ client: this.lab.client, contextId, collectState, settleMs, evaluateTimeoutMs });
      return completer.complete({ execute: true, signal });
    }
    if (["preflight-warehouse-store", "store-to-warehouse", "load-warehouse-inventory", "retrieve-from-warehouse"].includes(command.type)) {
      const warehouse = new WarehouseActionExecutor({
        client: this.lab.client,
        contextId,
        collectState,
        settleMs,
        evaluateTimeoutMs,
        onInventoryKnowledgeInvalidated: this.onWarehouseInventoryInvalidated,
      });
      if (command.type === "preflight-warehouse-store") return warehouse.preflight(command.index, { signal });
      if (command.type === "store-to-warehouse") return warehouse.move(command.index, { execute: true, signal, preflight: command.preflight });
      if (command.type === "load-warehouse-inventory") return warehouse.loadInventory({ execute: true, signal });
      return warehouse.retrieve(command.action, { ...command.request, execute: true, signal });
    }
    if (command.type === "switch-production-mode") {
      const productionModes = new ProductionModeExecutor({ client: this.lab.client, contextId, settleMs, evaluateTimeoutMs });
      return productionModes.switch(command.index, command.modeId, { ...command.request, execute: true, signal });
    }
    throw Object.assign(new Error(`unsupported runtime control command: ${command.type}`), {
      code: "RUNTIME_CONTROL_COMMAND_UNSUPPORTED",
      reason: "runtime-control-command-unsupported",
    });
  }
}

/**
 * In-memory Adapter for Automation Runtime scenarios. Script entries may be
 * records, Errors, or async functions receiving the command and AbortSignal.
 */
class FakeRuntimeControlAdapter {
  constructor({ states = [], results = [], readiness = null } = {}) {
    this.states = [...states];
    this.results = [...results];
    this.readiness = readiness || { adapterId: "fake-runtime-control", contextId: "fake-context", capabilities: ["state", "actions"] };
    this.commands = [];
    this.readCount = 0;
    this.readyCount = 0;
  }

  async ready(signal = null) {
    this.readyCount += 1;
    return resolveFakeEntry(this.readiness, { signal, adapter: this });
  }

  async readState(signal = null) {
    const index = this.readCount;
    this.readCount += 1;
    const entry = this.states[Math.min(index, this.states.length - 1)];
    if (entry == null) throw Object.assign(new Error("fake runtime control has no state"), { code: "FAKE_RUNTIME_CONTROL_STATE_MISSING" });
    return resolveFakeEntry(entry, { signal, readIndex: index, adapter: this });
  }

  async execute(command, { signal = null } = {}) {
    assertNotAborted(signal);
    const index = this.commands.length;
    this.commands.push(cloneRecord(command));
    const entry = this.results[index];
    if (entry == null) throw Object.assign(new Error(`fake runtime control has no result for ${command?.type || "unknown"}`), { code: "FAKE_RUNTIME_CONTROL_RESULT_MISSING" });
    return resolveFakeEntry(entry, { signal, command: cloneRecord(command), commandIndex: index, adapter: this });
  }
}

module.exports = {
  FakeRuntimeControlAdapter,
  LegacyRuntimeControlAdapter,
  abortError,
};
