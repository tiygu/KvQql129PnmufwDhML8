#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { summarizeSnapshot } = require("./summarize-target-snapshot.cjs");

const readState = (file) => summarizeSnapshot(JSON.parse(fs.readFileSync(file, "utf8")));
const resourceMap = (state) => new Map(state.resources.map((item) => [Number(item.type), Number(item.amount)]));
const allReady = (task) => task.items.length > 0 && task.items.every((item) => item.complete);

function analyzeOrderCaptures(before, ready, after) {
  const beforeResources = resourceMap(before);
  const readyResources = resourceMap(ready);
  const afterResources = resourceMap(after);
  const becameReady = ready.tasks.find((task) => {
    const previous = before.tasks.find((item) => item.slot === task.slot);
    return previous && !allReady(previous) && allReady(task);
  });
  const previousTask = becameReady ? before.tasks.find((task) => task.slot === becameReady.slot) : null;
  const replacement = becameReady ? after.tasks.find((task) => task.taskId === becameReady.taskId && task.slot !== becameReady.slot) : null;
  const resourceChanges = [...new Set([...beforeResources.keys(), ...afterResources.keys()])].map((type) => ({
    type,
    before: beforeResources.get(type) ?? null,
    ready: readyResources.get(type) ?? null,
    after: afterResources.get(type) ?? null,
    totalDelta: (afterResources.get(type) ?? 0) - (beforeResources.get(type) ?? 0),
  }));

  return {
    generatedAt: new Date().toISOString(),
    result: becameReady && replacement ? "order-completion-confirmed" : "order-transition-not-found",
    completedOrder: becameReady ? {
      taskId: becameReady.taskId,
      slotBefore: becameReady.slot,
      rewardCoins: becameReady.rewards.find((reward) => Number(reward.type) === 1)?.count ?? becameReady.awardValue,
      requirementsBefore: previousTask?.items ?? [],
      requirementsReady: becameReady.items,
    } : null,
    replacementOrder: replacement ? {
      taskId: replacement.taskId,
      slotAfter: replacement.slot,
      displayRoleId: replacement.displayRoleId,
      rewardCoins: replacement.rewards.find((reward) => Number(reward.type) === 1)?.count ?? replacement.awardValue,
      requirements: replacement.items,
    } : null,
    resourceChanges,
    verification: {
      expectedCoinReward: becameReady?.rewards.find((reward) => Number(reward.type) === 1)?.count ?? null,
      observedCoinIncrease: (afterResources.get(1) ?? 0) - (readyResources.get(1) ?? 0),
      rewardMatchesObservedIncrease: becameReady
        ? Number(becameReady.rewards.find((reward) => Number(reward.type) === 1)?.count) === (afterResources.get(1) ?? 0) - (readyResources.get(1) ?? 0)
        : false,
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const captureDir = path.resolve(argv[0] || "captures");
  const output = path.resolve(argv[1] || path.join(captureDir, "order-completion-analysis.json"));
  const report = analyzeOrderCaptures(
    readState(path.join(captureDir, "30-order-before.json")),
    readState(path.join(captureDir, "31-order-ready.json")),
    readState(path.join(captureDir, "32-order-completed.json")),
  );
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`Order completion analysis written: ${output}`);
  return report;
}

if (require.main === module) main();

module.exports = { analyzeOrderCaptures };
