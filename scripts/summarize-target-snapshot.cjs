#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const mapEntries = (value) => value?.kind === "Map" && Array.isArray(value.entries) ? value.entries : [];
const arrayItems = (value) => value?.kind === "Array" && Array.isArray(value.items) ? value.items : [];
const fieldsOf = (value) => value?.fields || value?.primitiveFields || {};

function flattenNestedMap(value) {
  const result = [];
  for (const [group, nested] of mapEntries(value)) {
    for (const [key, item] of mapEntries(nested)) result.push({ group, key, item });
  }
  return result;
}

function normalizeTask(entry) {
  const fields = fieldsOf(entry.item);
  const slot = fieldsOf(fields.ymdOrderSlotData);
  return {
    group: entry.group,
    slot: entry.key,
    taskId: fields.taskId ?? null,
    taskType: fields.taskType ?? null,
    roleId: fields.roleId ?? null,
    displayRoleId: fields.displayRoleId ?? null,
    awardValue: slot.awardValue ?? null,
    completed: !!fields._isEndTask,
    items: arrayItems(fields.itemInfos).map((item) => {
      const value = fieldsOf(item);
      return { itemId: value.itemId ?? null, complete: !!value.isComplete, status: value.status ?? null };
    }),
    rewards: arrayItems(fields.rewards).map((reward) => {
      const value = fieldsOf(reward);
      return { type: value.type ?? null, id: value.id ?? null, count: value.count ?? null };
    }),
  };
}

function summarizeSnapshot(snapshot) {
  const domain = snapshot.domainManagers || {};
  const resourceEntries = mapEntries(domain.resources?.data?._resourceMap);
  const energyEntries = mapEntries(domain.energy?.data?._energyDataMap);
  const taskEntries = flattenNestedMap(domain.tasks?.data?.clientTaskDataMap);
  const itemRanges = mapEntries(domain.items?.data?._historyItemMap);
  const statistics = flattenNestedMap(domain.statistics?.data?._statisticsDataMap);
  const schema = (snapshot.mapBehaviors || []).find((item) => item?.name === "mSchemaModelBehavior")?.primitiveFields || {};
  const gameplay = snapshot.gameplayState || {};
  const mission = gameplay.mapMission || null;

  return {
    generatedAt: new Date().toISOString(),
    sourceAdapter: snapshot.adapter || null,
    engine: snapshot.engine || null,
    scene: {
      nodeCountObserved: snapshot.counts?.total ?? null,
      activeNodes: snapshot.counts?.active ?? null,
      inactiveNodes: snapshot.counts?.inactive ?? null,
    },
    resources: resourceEntries.map(([type, amount]) => ({ type: Number(type), amount })),
    energy: energyEntries.map(([type, value]) => {
      const fields = fieldsOf(value);
      const amount = resourceEntries.find(([resourceType]) => String(resourceType) === String(type))?.[1] ?? null;
      return {
        type: Number(type),
        amount,
        limit: fields._energyLimit ?? null,
        recoverIntervalSeconds: fields._recoverInterval ?? null,
        recoverTimestamp: fields.recoverTimestamp ?? null,
        recovering: !!fields.inRecover,
      };
    }),
    tasks: taskEntries.map(normalizeTask),
    taskSummary: {
      total: taskEntries.length,
      ready: taskEntries.filter((entry) => normalizeTask(entry).items.every((item) => item.complete)).length,
      incomplete: taskEntries.filter((entry) => normalizeTask(entry).items.some((item) => !item.complete)).length,
    },
    discoveredItemRanges: itemRanges.map(([start, value]) => {
      const fields = fieldsOf(value);
      return { start: Number(fields.rangeStart ?? start), end: Number(fields.rangeEnd ?? start) };
    }),
    statistics: statistics.map(({ group, key, item }) => ({ group, type: key, value: item })),
    mapProgress: {
      currentTask: schema._curTask ?? null,
      currentSeason: schema._curSeason ?? null,
      seasonDisplay: schema._seasonDisplay ?? null,
      allFinished: !!schema._isAllFinished,
      episodeFinished: !!schema._episodeFinished,
    },
    mapMission: mission ? {
      id: mission.id ?? null,
      titleKey: mission.titleKey ?? null,
      reward: mission.reward ?? null,
      nextId: mission.nextId ?? null,
      canUpgrade: !!mission.canUpgrade,
      requirements: arrayItems(mission.needType).map((type, index) => ({
        resourceType: Number(type),
        required: Number(arrayItems(mission.needAmount)[index] ?? 0),
      })),
    } : null,
    gameplay: {
      mode: gameplay.mode ?? null,
      selectedItem: gameplay.selectedItemUi ?? null,
      warehouse: gameplay.warehouse ? {
        visible: !!gameplay.warehouse.visible,
        loaded: Number(gameplay.warehouse.totalSlots ?? 0) > 0,
        totalSlots: gameplay.warehouse.totalSlots ?? 0,
        unlockedSlots: gameplay.warehouse.unlockedSlots ?? 0,
        occupiedSlots: Array.isArray(gameplay.warehouse.occupiedSlots) ? gameplay.warehouse.occupiedSlots.length : 0,
      } : null,
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const input = path.resolve(argv[0] || "target-game-snapshot.json");
  const output = path.resolve(argv[1] || "target-game-state.json");
  const snapshot = JSON.parse(fs.readFileSync(input, "utf8"));
  const state = summarizeSnapshot(snapshot);
  fs.writeFileSync(output, JSON.stringify(state, null, 2) + "\n", "utf8");
  console.log(`State report written: ${output}`);
  return state;
}

if (require.main === module) main();

module.exports = { summarizeSnapshot, normalizeTask, flattenNestedMap };
