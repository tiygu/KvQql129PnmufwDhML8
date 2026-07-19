"use strict";

const { gridUnavailabilityReasons } = require("./inventory-availability");

const WAREHOUSE_REASONS = Object.freeze({
  invalidSource: "warehouse-source-invalid",
  unavailableSource: "warehouse-source-not-moveable",
  reservedSource: "warehouse-source-reserved-for-order",
  producerSource: "warehouse-source-is-producer",
  insufficientEvidence: "warehouse-store-evidence-insufficient",
});

function unknownWarehouseInventoryKnowledge(reason = null) {
  return {
    status: "unknown", totalSlots: null, unlockedSlots: null, occupiedSlots: null, exchangeCapacity: null,
    revision: null, slots: [], items: [], retrievalPath: { status: "unknown", type: "native-click" }, reason,
  };
}

function normalizeWarehouseState(warehouse) {
  if (!warehouse) return { visible: false, inventoryKnowledge: unknownWarehouseInventoryKnowledge(), storeAvailability: { status: "unknown" } };
  const explicit = warehouse.inventoryKnowledge;
  const requestedLoaded = explicit?.status === "loaded" || (!explicit && warehouse.loaded === true);
  const numberOrNull = (value) => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
  const totalSlots = requestedLoaded ? numberOrNull(explicit?.totalSlots ?? warehouse.totalSlots) : null;
  const unlockedSlots = requestedLoaded ? numberOrNull(explicit?.unlockedSlots ?? warehouse.unlockedSlots) : null;
  const occupiedSlots = requestedLoaded ? numberOrNull(explicit?.occupiedSlots ?? warehouse.occupiedSlots) : null;
  const loaded = requestedLoaded && totalSlots != null && unlockedSlots != null && occupiedSlots != null;
  const slots = loaded ? (explicit?.slots || warehouse.slots || []).map((slot) => ({
    slotId: String(slot.slotId ?? slot.gridId ?? ""), itemId: String(slot.itemId ?? slot.item?.itemId ?? ""),
    occupied: slot.occupied == null ? !!(slot.itemId ?? slot.item) : !!slot.occupied,
  })) : [];
  const slotCounts = new Map();
  for (const slot of slots) if (slot.occupied && slot.itemId) slotCounts.set(slot.itemId, (slotCounts.get(slot.itemId) || 0) + 1);
  const items = loaded && explicit?.items?.length
    ? explicit.items.map((item) => ({ itemId: String(item.itemId), count: Math.max(0, Number(item.count) || 0) }))
    : [...slotCounts].map(([itemId, count]) => ({ itemId, count }));
  return {
    visible: !!warehouse.visible,
    inventoryKnowledge: loaded ? {
      status: "loaded", totalSlots, unlockedSlots, occupiedSlots,
      exchangeCapacity: Math.max(0, unlockedSlots - occupiedSlots),
      revision: explicit?.revision == null ? null : String(explicit.revision),
      slots,
      items,
      retrievalPath: explicit?.retrievalPath ? { ...explicit.retrievalPath } : { status: "unknown", type: "native-click" },
      reason: explicit?.reason ?? null,
    } : unknownWarehouseInventoryKnowledge(explicit?.reason ?? null),
    storeAvailability: warehouse.storeAvailability ? { ...warehouse.storeAvailability } : { status: "unknown" },
  };
}

function warehouseInventoryKnowledgeFromNative(value) {
  if (!value?.ok) return unknownWarehouseInventoryKnowledge(value?.reason || "warehouse-inventory-unavailable");
  return normalizeWarehouseState({ inventoryKnowledge: {
    status: "loaded", totalSlots: value.totalSlots, unlockedSlots: value.unlockedSlots, occupiedSlots: value.occupiedSlots,
    revision: value.revision, slots: value.slots || [], retrievalPath: { status: "trusted", type: "native-click" },
  } }).inventoryKnowledge;
}

function warehouseGridEligibility(grid, { requiredItemIds = null, catalogItemKnown = true } = {}) {
  if (!grid || grid.empty || !grid.itemId) return { eligible: false, reason: WAREHOUSE_REASONS.invalidSource, unavailableReasons: [] };
  if (grid.taskNeed || grid.protected || requiredItemIds?.has?.(String(grid.itemId))) return { eligible: false, reason: WAREHOUSE_REASONS.reservedSource, unavailableReasons: [] };
  if (grid.produceCount != null) return { eligible: false, reason: WAREHOUSE_REASONS.producerSource, unavailableReasons: [] };
  const unavailableReasons = typeof grid.executable === "boolean" ? (grid.executable ? [] : grid.unavailableReasons || ["unavailable"]) : gridUnavailabilityReasons(grid);
  if (unavailableReasons.length) return { eligible: false, reason: WAREHOUSE_REASONS.unavailableSource, unavailableReasons };
  if (!catalogItemKnown) return { eligible: false, reason: WAREHOUSE_REASONS.insufficientEvidence, unavailableReasons: [] };
  return { eligible: true, reason: null, unavailableReasons: [] };
}

module.exports = { WAREHOUSE_REASONS, normalizeWarehouseState, unknownWarehouseInventoryKnowledge, warehouseGridEligibility, warehouseInventoryKnowledgeFromNative };
