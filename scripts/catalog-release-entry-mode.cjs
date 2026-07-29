#!/usr/bin/env node
"use strict";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.message
      || payload?.error
      || `request failed with ${response.status}`,
    );
  }
  return payload;
}

async function main() {
  const baseUrl = new URL(
    argument("--base-url", "http://127.0.0.1:3210"),
  );
  const entryMode = argument("--entry-mode");
  if (!["full-snapshot", "legacy-advanced"].includes(entryMode)) {
    throw new TypeError("--entry-mode must be full-snapshot or legacy-advanced");
  }
  const endpoint = new URL("/api/catalog/release-control", baseUrl);
  await requestJson(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entryMode }),
  });
  const verified = await requestJson(endpoint);
  const actualMode = verified?.releaseControl?.entryMode
    || verified?.entryMode
    || null;
  if (actualMode !== entryMode) {
    throw new Error(`entry mode verification failed: expected ${entryMode}, got ${actualMode}`);
  }
  process.stdout.write(`${JSON.stringify({ entryMode: actualMode })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
