#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  collectRuntimeSmokeEvidence,
} = require("../src/catalog-release-runtime-smoke");
const {
  validateRuntimeSmokeEvidence,
} = require("../src/catalog-release-gates");

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const evidencePath = path.resolve(
    argument("--evidence", ".release-inputs/catalog-runtime-smoke.json"),
  );
  const evidence = await collectRuntimeSmokeEvidence({
    baseUrl: argument("--base-url", "http://127.0.0.1:3210"),
    mergeChainId: argument("--merge-chain-id"),
    idempotencyPrefix: argument(
      "--idempotency-prefix",
      `release-${Date.now()}`,
    ),
    minimumMembers: Number(argument("--minimum-members", "20")),
    minimumSucceeded: Number(argument("--minimum-succeeded", "1")),
    maximumDeferred: Number(
      argument("--maximum-deferred", String(Number.MAX_SAFE_INTEGER)),
    ),
    maximumFailed: Number(argument("--maximum-failed", "0")),
    timeoutMs: Number(argument("--timeout-ms", String(10 * 60 * 1000))),
  });
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${evidencePath}\n`);
  const failures = validateRuntimeSmokeEvidence(evidence);
  if (failures.length) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
