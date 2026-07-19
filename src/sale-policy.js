"use strict";

const DEFAULT_SALE_POLICY = Object.freeze({ automaticEnabled: false, rules: [] });
const RULE_SCOPES = new Set(["item", "chain", "level"]);
const RULE_DISPOSITIONS = new Set(["never", "surplus", "preferred"]);

function normalizeSalePolicy(policy = {}) {
  return {
    automaticEnabled: false,
    rules: (policy.rules || []).filter((rule) => RULE_SCOPES.has(rule?.scope) && RULE_DISPOSITIONS.has(rule?.disposition)).map((rule) => ({
      scope: rule.scope,
      value: rule.scope === "level" ? Number(rule.value) : String(rule.value),
      disposition: rule.disposition,
      ...(rule.disposition === "surplus" ? { keep: Math.max(0, Math.floor(Number(rule.keep) || 0)) } : {}),
    })),
  };
}

function matchingRules(item, policy) {
  return policy.rules.filter((rule) => rule.scope === "item" && String(rule.value) === item.id
    || rule.scope === "chain" && String(rule.value) === String(item.chainId)
    || rule.scope === "level" && Number(rule.value) === Number(item.level));
}

function buildSaleSuggestions(state, { policy = DEFAULT_SALE_POLICY, spacePressureUnresolved = false, safeMergeAvailable = false, warehouseBufferAvailable = false } = {}) {
  const normalizedPolicy = normalizeSalePolicy(policy);
  const mapCoinDeficit = Math.max(0, Number(state.mapCoinDeficit || 0));
  const pressureTrigger = spacePressureUnresolved && !safeMergeAvailable && !warehouseBufferAvailable;
  if (mapCoinDeficit <= 0 && !pressureTrigger) return [];
  const itemById = new Map((state.catalog?.items || []).map((item) => [String(item.id), item]));
  const producerIds = new Set((state.catalog?.producers || []).map((producer) => String(producer.itemId)));
  const eligible = (state.board?.grids || []).filter((grid) => {
    const item = itemById.get(String(grid.itemId || ""));
    return grid.itemId && !grid.empty && grid.executable !== false && !grid.protected && grid.produceCount == null
      && !producerIds.has(String(grid.itemId)) && item?.evidenceSufficient === true && !item.special && !grid.special
      && Number(grid.saleValue ?? item.saleValue ?? 0) > 0;
  }).map((grid) => ({ grid, item: { ...itemById.get(String(grid.itemId)), saleValue: Number(grid.saleValue ?? itemById.get(String(grid.itemId))?.saleValue ?? 0) } }));
  const counts = new Map();
  const chainCounts = new Map();
  const levelCounts = new Map();
  for (const { item } of eligible) {
    counts.set(item.id, (counts.get(item.id) || 0) + 1);
    chainCounts.set(String(item.chainId), (chainCounts.get(String(item.chainId)) || 0) + 1);
    levelCounts.set(Number(item.level), (levelCounts.get(Number(item.level)) || 0) + 1);
  }
  const scopeCount = (rule) => rule.scope === "item" ? counts.get(String(rule.value)) || 0
    : rule.scope === "chain" ? chainCounts.get(String(rule.value)) || 0
      : levelCounts.get(Number(rule.value)) || 0;
  const ranked = [];
  for (const { grid, item } of eligible) {
    const rules = matchingRules(item, normalizedPolicy);
    if (rules.some((rule) => rule.disposition === "never")) continue;
    const surplusRules = rules.filter((rule) => rule.disposition === "surplus");
    const preferred = rules.some((rule) => rule.disposition === "preferred");
    const producerCosts = (state.catalog?.producers || []).flatMap((producer) => (producer.drops || []).filter((drop) => String(drop.itemId) === item.id).map((drop) => Number(producer.energyCost || 0) / Math.max(0.001, Number(drop.probability || 0) * Number(drop.count || 1))));
    const rebuildCost = (producerCosts.length ? Math.min(...producerCosts) : Number(item.baseUnits || 1)) * Math.max(1, Number(item.baseUnits || 1));
    const chainScarcity = Number(item.baseUnits || 1) / Math.max(1, chainCounts.get(String(item.chainId)) || 0);
    const saleReturn = Number(item.saleValue || 0);
    const spaceValue = pressureTrigger ? 20 : 0;
    const mapProgress = Math.min(saleReturn, mapCoinDeficit);
    const opportunityValue = rebuildCost * 4 + chainScarcity * 6 - saleReturn * 0.15 - spaceValue - mapProgress * 0.2 - (preferred ? 25 : 0);
    ranked.push({
      type: "sell-item", sourceIndex: Number(grid.index), itemId: item.id, chainId: item.chainId, level: item.level,
      expectedCoins: saleReturn, mapProgressCoins: mapProgress, opportunityValue,
      policyDisposition: preferred && surplusRules.length ? "preferred-surplus" : preferred ? "preferred" : surplusRules.length ? "surplus" : "allowed",
      reason: mapCoinDeficit > 0 && pressureTrigger ? "map-coin-deficit-and-space-pressure" : mapCoinDeficit > 0 ? "map-coin-deficit" : "unresolved-space-pressure",
      requiresConfirmation: true, automaticExecutionEnabled: false,
      valueBreakdown: { rebuildCost, chainScarcity, saleReturn, spaceValue, mapProgress },
      surplusRules,
    });
  }
  ranked.sort((left, right) => left.opportunityValue - right.opportunityValue || right.expectedCoins - left.expectedCoins || left.sourceIndex - right.sourceIndex);
  const emittedByRule = new Map();
  const selected = [];
  for (const candidate of ranked) {
    if (candidate.surplusRules.some((rule) => (emittedByRule.get(rule) || 0) >= Math.max(0, scopeCount(rule) - rule.keep))) continue;
    for (const rule of candidate.surplusRules) emittedByRule.set(rule, (emittedByRule.get(rule) || 0) + 1);
    const { surplusRules, ...suggestion } = candidate;
    selected.push(suggestion);
  }
  return selected;
}

module.exports = { DEFAULT_SALE_POLICY, normalizeSalePolicy, buildSaleSuggestions };
