"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { buildOptimizationPlan } = require("./order-optimizer");

try {
  parentPort.postMessage({ ok: true, plan: buildOptimizationPlan(workerData) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.message || String(error), stack: error?.stack || null });
}
