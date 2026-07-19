"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { processIconResource } = require("./icon-evidence");
const { processScreenshotFrames } = require("./icon-screenshot-evidence");

try {
  const result = workerData.operation === "screenshot-frames" ? processScreenshotFrames(workerData) : { asset: processIconResource(workerData) };
  parentPort.postMessage(result);
} catch (error) {
  parentPort.postMessage({ error: { message: error.message, stack: error.stack } });
}
