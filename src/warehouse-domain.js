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
  return { status: "unknown", totalSlots: null, unlockedSlots: null, occupiedSlots: null, exchangeCapacity: null, reason };
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
  return {
    visible: !!warehouse.visible,
    inventoryKnowledge: loaded ? {
      status: "loaded", totalSlots, unlockedSlots, occupiedSlots,
      exchangeCapacity: Math.max(0, unlockedSlots - occupiedSlots), reason: explicit?.reason ?? null,
    } : unknownWarehouseInventoryKnowledge(explicit?.reason ?? null),
    storeAvailability: warehouse.storeAvailability ? { ...warehouse.storeAvailability } : { status: "unknown" },
  };
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

module.exports = { WAREHOUSE_REASONS, normalizeWarehouseState, unknownWarehouseInventoryKnowledge, warehouseGridEligibility };
