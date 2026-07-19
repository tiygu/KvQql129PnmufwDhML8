"use strict";

const { setTimeout: delay } = require("node:timers/promises");

async function waitForDelay(ms, signal = null) {
  if (signal?.aborted) return false;
  const abortSignal = signal && typeof signal.addEventListener === "function" ? signal : null;
  try {
    await delay(ms, null, abortSignal ? { signal: abortSignal } : undefined);
    return true;
  } catch (error) {
    if (error?.name === "AbortError") return false;
    throw error;
  }
}

module.exports = { waitForDelay };
