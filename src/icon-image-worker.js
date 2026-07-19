"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { processIconResource } = require("./icon-evidence");

try {
  parentPort.postMessage({ asset: processIconResource(workerData) });
} catch (error) {
  parentPort.postMessage({ error: { message: error.message, stack: error.stack } });
}
