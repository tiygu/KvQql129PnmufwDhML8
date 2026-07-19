"use strict";

const RESOURCE_NAMES = new Map([[1, "金币"], [2, "钻石"], [3, "体力"]]);

function normalizeMapMission(state, resourceByType = null) {
  const mission = state.mapMission || null;
  const progressTaskId = state.mapProgress?.currentTask == null ? null : String(state.mapProgress.currentTask);
  if (!mission && !progressTaskId) return null;
  const configuredTaskId = mission?.id == null ? null : String(mission.id);
  const configurationStale = Boolean(mission?.configurationStale || (progressTaskId && configuredTaskId && progressTaskId !== configuredTaskId));
  const requirements = (mission?.requirements || []).map((requirement) => {
    const current = resourceByType
      ? Number(resourceByType.get(Number(requirement.resourceType)) ?? requirement.current ?? 0)
      : Number(requirement.current ?? 0);
    const required = Number(requirement.required ?? 0);
    return { ...requirement, current, required, deficit: Math.max(0, required - current), enough: current >= required };
  });
  return {
    ...mission,
    id: progressTaskId || configuredTaskId,
    configuredTaskId,
    progressTaskId,
    configurationStale,
    requirements,
    canComplete: !configurationStale && requirements.length > 0 && requirements.every((item) => item.enough),
  };
}

function buildStatusReport(state) {
  if (state?.schemaVersion === 1 && state.resources && !Array.isArray(state.resources)) {
    const resources = [
      { type: 1, name: "金币", amount: state.resources.coins },
      { type: 2, name: "钻石", amount: state.resources.diamonds },
      { type: 3, name: "体力", amount: state.resources.energy },
    ];
    const boardOrders = (state.orders || []).map((order) => ({ ...order }));
    return {
      generatedAt: state.collectedAt,
      mode: state.scene,
      resources,
      energy: state.energy,
      boardOrders,
      orderSummary: {
        total: boardOrders.length,
        ready: boardOrders.filter((order) => order.ready).length,
        incomplete: boardOrders.filter((order) => !order.ready).length,
      },
      mapMission: normalizeMapMission(state),
      warehouse: state.warehouse,
      selectedItem: state.selectedItem,
    };
  }

  const resourceByType = new Map((state.resources || []).map((item) => [Number(item.type), item.amount]));
  const orders = (state.tasks || []).map((task) => {
    const missingItemIds = task.items.filter((item) => !item.complete).map((item) => item.itemId);
    return {
      slot: task.slot,
      taskId: task.taskId,
      rewardCoins: task.rewards.find((reward) => Number(reward.type) === 1)?.count ?? task.awardValue,
      ready: task.items.length > 0 && missingItemIds.length === 0,
      missingItemIds,
      requiredItemIds: task.items.map((item) => item.itemId),
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    mode: state.gameplay?.mode ?? null,
    resources: (state.resources || []).map((item) => ({ type: Number(item.type), name: RESOURCE_NAMES.get(Number(item.type)) || `资源${item.type}`, amount: item.amount })),
    energy: state.energy?.[0] || null,
    boardOrders: orders,
    orderSummary: { total: orders.length, ready: orders.filter((order) => order.ready).length, incomplete: orders.filter((order) => !order.ready).length },
    mapMission: normalizeMapMission(state, resourceByType),
    warehouse: state.gameplay?.warehouse ?? null,
    selectedItem: state.gameplay?.selectedItem ?? null,
  };
}

function printStatusReport(report, output = console) {
  output.log(`当前界面：${report.mode || "unknown"}`);
  output.log("\n资源：");
  output.table(report.resources.map((item) => ({ 资源: item.name, 数量: item.amount })));
  output.log("\n棋盘订单：");
  output.table(report.boardOrders.map((order) => ({ 槽位: order.slot, 奖励金币: order.rewardCoins, 状态: order.ready ? "可提交" : "未完成", 缺少物品: order.missingItemIds.join(", ") || "-" })));
  if (report.mapMission) {
    output.log(`\n地图任务：${report.mapMission.id} → ${report.mapMission.nextId || "-"}`);
    if (report.mapMission.configurationStale) {
      output.log(`任务配置待刷新（当前加载的是 ${report.mapMission.configuredTaskId || "unknown"}）`);
    } else {
      output.table(report.mapMission.requirements.map((item) => ({ 资源: RESOURCE_NAMES.get(Number(item.resourceType)) || item.resourceType, 当前: item.current, 需要: item.required, 缺口: item.deficit, 状态: item.enough ? "已满足" : "不足" })));
    }
  }
  if (report.warehouse) {
    const knowledge = report.warehouse.inventoryKnowledge;
    output.log(knowledge?.status === "loaded" || report.warehouse.loaded
      ? `\n仓库：已占用 ${knowledge?.occupiedSlots ?? report.warehouse.occupiedSlots ?? 0} / 已解锁 ${knowledge?.unlockedSlots ?? report.warehouse.unlockedSlots ?? 0} / 总格数 ${knowledge?.totalSlots ?? report.warehouse.totalSlots ?? 0}`
      : "\n仓库：清单知识未知；具体物品仍可通过原生预检判断存入可用性");
  }
  if (report.warehouse?.inventoryKnowledge?.status === "loaded") {
    const knowledge = report.warehouse.inventoryKnowledge;
    output.log(`Warehouse revision: ${knowledge.revision || "unknown"}; concrete items: ${(knowledge.items || []).map((item) => `${item.itemId} x${item.count}`).join(", ") || "none"}; retrieval path: ${knowledge.retrievalPath?.status || "unknown"}`);
  }
  if (report.selectedItem?.selected) output.log(`选中物品：${report.selectedItem.name || "unknown"}${report.selectedItem.price != null ? `（价格 ${report.selectedItem.price}）` : ""}`);
}

module.exports = { buildStatusReport, printStatusReport, RESOURCE_NAMES, normalizeMapMission };
