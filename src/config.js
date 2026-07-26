"use strict";

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getConfig(overrides = {}) {
  return {
    url: overrides.url || process.env.CDP_URL || "ws://127.0.0.1:62000",
    timeoutMs: overrides.timeoutMs || numberFromEnv("CDP_TIMEOUT_MS", 10_000),
    discoveryMs: overrides.discoveryMs || numberFromEnv("CDP_DISCOVERY_MS", 1_500),
  };
}

module.exports = { getConfig };
