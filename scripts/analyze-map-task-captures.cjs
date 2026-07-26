#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const mapEntries = (value) => value?.kind === "Map" && Array.isArray(value.entries) ? value.entries : [];
const arrayItems = (value) => value?.kind === "Array" && Array.isArray(value.items) ? value.items : [];
const resources = (snapshot) => new Map(mapEntries(snapshot.domainManagers?.resources?.data?._resourceMap).map(([type, amount]) => [Number(type), Number(amount)]));

function normalizeMission(snapshot) {
  const mission = snapshot.gameplayState?.mapMission || {};
  const types = arrayItems(mission.needType);
  const amounts = arrayItems(mission.needAmount);
  const currentResources = resources(snapshot);
  return {
    id: mission.id ?? null,
    titleKey: mission.titleKey ?? null,
    reward: mission.reward ?? null,
    nextId: mission.nextId ?? null,
    canUpgrade: !!mission.canUpgrade,
    requirements: types.map((type, index) => ({
      resourceType: Number(type),
      current: currentResources.get(Number(type)) ?? null,
      required: Number(amounts[index] ?? 0),
    })),
  };
}

function analyzeMapTaskCaptures(beforeSnapshot, afterSnapshot) {
  const before = normalizeMission(beforeSnapshot);
  const after = normalizeMission(afterSnapshot);
  const beforeResources = resources(beforeSnapshot);
  const afterResources = resources(afterSnapshot);
  const types = [...new Set([...beforeResources.keys(), ...afterResources.keys()])];
  const resourceChanges = types.map((type) => ({
    type,
    before: beforeResources.get(type) ?? null,
    after: afterResources.get(type) ?? null,
    delta: (afterResources.get(type) ?? 0) - (beforeResources.get(type) ?? 0),
  }));
  const expectedCost = before.requirements.find((item) => item.resourceType === 1)?.required ?? null;
  const observedCoinCost = (beforeResources.get(1) ?? 0) - (afterResources.get(1) ?? 0);
  return {
    generatedAt: new Date().toISOString(),
    result: before.id !== after.id && before.nextId === after.id ? "map-task-completion-confirmed" : "map-task-transition-not-found",
    completedMission: before,
    nextMission: after,
    resourceChanges,
    verification: {
      expectedCoinCost: expectedCost,
      observedCoinCost,
      costMatchesObservedDecrease: expectedCost === observedCoinCost,
      nextMissionMatchesConfiguredNextId: before.nextId === after.id,
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const captureDir = path.resolve(argv[0] || "captures");
  const output = path.resolve(argv[1] || path.join(captureDir, "map-task-completion-analysis.json"));
  const report = analyzeMapTaskCaptures(
    readJson(path.join(captureDir, "40-map-task-before.json")),
    readJson(path.join(captureDir, "41-map-task-after.json")),
  );
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`Map task completion analysis written: ${output}`);
  return report;
}

if (require.main === module) main();

module.exports = { analyzeMapTaskCaptures, normalizeMission };
