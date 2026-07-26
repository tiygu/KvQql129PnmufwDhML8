#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const fieldsOf = (value) => value?.fields || value?.primitiveFields || {};
const mapEntries = (value) => value?.kind === "Map" && Array.isArray(value.entries) ? value.entries : [];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function resourceAmount(snapshot, type) {
  const map = snapshot.domainManagers?.resources?.data?._resourceMap;
  return mapEntries(map).find(([key]) => Number(key) === Number(type))?.[1] ?? null;
}

function unwrapArray(value) {
  return value?.kind === "Array" && Array.isArray(value.items) ? value.items : [];
}

function normalizeWarehouseItem(slot) {
  const item = fieldsOf(slot.item);
  const config = fieldsOf(item.itemConfig || item.config || item._itemConfig);
  return {
    gridId: slot.gridId ?? null,
    itemId: config.id ?? item.itemId ?? item.id ?? null,
    itemType: config.ItemType ?? null,
    level: config.Level ?? null,
    mergeChain: config.MergeChain ?? null,
    mergeTarget: config.MergeTarget ?? null,
    iconResource: config.IconRes ?? null,
    salePrice: config.Price ?? null,
    coinValue: config.CoinValue ?? null,
    energyValue: config.EnergyValue ?? null,
  };
}

function analyzeCaptures(captures) {
  const initial = captures.boardInitial;
  const selected = captures.boardSelected;
  const warehouse = captures.warehouse;
  const mission = captures.mapMission;
  const missionState = mission.gameplayState?.mapMission || {};
  const needTypes = unwrapArray(missionState.needType);
  const needAmounts = unwrapArray(missionState.needAmount);
  const requirements = needTypes.map((type, index) => {
    const required = Number(needAmounts[index] ?? 0);
    const current = Number(resourceAmount(mission, type) ?? 0);
    return { resourceType: Number(type), current, required, deficit: Math.max(0, required - current) };
  });
  const occupied = warehouse.gameplayState?.warehouse?.occupiedSlots || [];
  const initialUi = initial.gameplayState?.selectedItemUi || {};
  const selectedUi = selected.gameplayState?.selectedItemUi || {};
  const emptyPrompt = (initial.labels || []).find((item) => /empty_container\/no_item_prompt\$Label$/.test(item.path) && item.text !== "no_item_prompt")?.text ?? null;

  return {
    generatedAt: new Date().toISOString(),
    conclusions: {
      initialBoardSelection: false,
      selectedCaptureSelection: true,
      gameplayLoop: "棋盘合成物品 -> 完成棋盘订单 -> 获得金币 -> 消耗金币完成地图任务",
    },
    board: {
      initial: {
        selected: false,
        prompt: emptyPrompt,
        price: initialUi.price ?? null,
      },
      selected: {
        selected: true,
        name: selectedUi.name ?? null,
        description: selectedUi.description ?? null,
        price: selectedUi.price ?? null,
      },
    },
    warehouse: {
      totalSlots: warehouse.gameplayState?.warehouse?.totalSlots ?? null,
      unlockedSlots: warehouse.gameplayState?.warehouse?.unlockedSlots ?? null,
      occupiedCount: occupied.length,
      items: occupied.map(normalizeWarehouseItem),
    },
    mapMission: {
      id: missionState.id ?? null,
      titleKey: missionState.titleKey ?? null,
      reward: missionState.reward ?? null,
      nextId: missionState.nextId ?? null,
      canUpgrade: !!missionState.canUpgrade,
      requirements,
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const captureDir = path.resolve(argv[0] || "captures");
  const output = path.resolve(argv[1] || path.join(captureDir, "gameplay-analysis.json"));
  const captures = {
    boardInitial: readJson(path.join(captureDir, fs.existsSync(path.join(captureDir, "23-board-unselected.json")) ? "23-board-unselected.json" : "20-board-state.json")),
    boardSelected: readJson(path.join(captureDir, fs.existsSync(path.join(captureDir, "24-board-selected.json")) ? "24-board-selected.json" : "20-board-state-1.json")),
    warehouse: readJson(path.join(captureDir, "21-warehouse-one-item.json")),
    mapMission: readJson(path.join(captureDir, "22-map-mission.json")),
  };
  const report = analyzeCaptures(captures);
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`Gameplay analysis written: ${output}`);
  return report;
}

if (require.main === module) main();

module.exports = { analyzeCaptures, normalizeWarehouseItem, resourceAmount };
