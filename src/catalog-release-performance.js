"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { AutomationDatabase } = require("./automation-database");
const { CatalogItemQuery } = require("./catalog-item-query");

function elapsedMs(started) {
  return Math.round(
    (Number(process.hrtime.bigint() - started) / 1_000_000) * 1000,
  ) / 1000;
}

function measure(action) {
  const started = process.hrtime.bigint();
  const result = action();
  return {
    result,
    durationMs: elapsedMs(started),
  };
}

function percentile95(values) {
  const sorted = values.map(Number).sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function fixtureCatalog(catalogSize) {
  const items = Array.from({ length: catalogSize }, (_, index) => {
    const itemId = `release-item-${String(index + 1).padStart(6, "0")}`;
    return {
      id: itemId,
      name: `Release item ${String(index + 1).padStart(6, "0")}`,
      chainId: "release-performance-chain",
      level: (index % 20) + 1,
      type: index % 5 === 0 ? "generator" : "merge-item",
      iconResource: `release/icons/${itemId}`,
      mergeTarget: index + 1 < catalogSize
        ? `release-item-${String(index + 2).padStart(6, "0")}`
        : null,
    };
  });
  return {
    chains: [{
      id: "release-performance-chain",
      minLevel: 1,
      maxLevel: 20,
      complete: true,
      itemIds: items.map((item) => item.id),
    }],
    items,
    producers: [],
  };
}

function measureCatalogPerformance({
  databasePath,
  catalogSize = 5000,
  queryThresholdMs = 250,
  projectionRebuildThresholdMs = 2000,
  now = () => new Date(),
} = {}) {
  const normalizedSize = Number(catalogSize);
  if (!Number.isInteger(normalizedSize) || normalizedSize < 1) {
    throw new TypeError("catalogSize must be a positive integer");
  }
  const resolvedDatabasePath = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true });
  const database = new AutomationDatabase(resolvedDatabasePath);
  try {
    database.importCatalog(fixtureCatalog(normalizedSize), {
      sourceFile: "catalog-release-performance.json",
      sourceType: "release-performance-fixture",
    });
    const sampleIndex = Math.max(1, Math.ceil(normalizedSize / 2));
    const sampleItemId = `release-item-${String(sampleIndex).padStart(6, "0")}`;
    const query = new CatalogItemQuery(database);
    query.list({ pageSize: 200, sort: "display-title", direction: "asc" });
    query.list({
      query: sampleItemId,
      pageSize: 50,
      sort: "relevance",
      direction: "asc",
    });
    query.detail(sampleItemId);

    const runs = [];
    for (let run = 1; run <= 3; run += 1) {
      const rebuilt = new CatalogItemQuery(database);
      const projectionRebuild = measure(() => rebuilt.revision());
      const list = measure(() => query.list({
        pageSize: 200,
        sort: "display-title",
        direction: "asc",
      }));
      const search = measure(() => query.list({
        query: sampleItemId,
        pageSize: 50,
        sort: "relevance",
        direction: "asc",
      }));
      const detail = measure(() => query.detail(sampleItemId));
      runs.push({
        run,
        listMs: list.durationMs,
        searchMs: search.durationMs,
        detailMs: detail.durationMs,
        projectionRebuildMs: projectionRebuild.durationMs,
        catalogQueryRevision: list.result.catalogQueryRevision,
      });
    }
    const p95 = {
      listMs: percentile95(runs.map((run) => run.listMs)),
      searchMs: percentile95(runs.map((run) => run.searchMs)),
      detailMs: percentile95(runs.map((run) => run.detailMs)),
      projectionRebuildMs: percentile95(
        runs.map((run) => run.projectionRebuildMs),
      ),
    };
    return {
      schemaVersion: 1,
      generatedAt: now().toISOString(),
      databasePath: resolvedDatabasePath,
      catalogSize: normalizedSize,
      sampleItemId,
      queryThresholdMs: Number(queryThresholdMs),
      projectionRebuildThresholdMs: Number(projectionRebuildThresholdMs),
      runs,
      p95,
      passed: p95.listMs <= Number(queryThresholdMs)
        && p95.searchMs <= Number(queryThresholdMs)
        && p95.detailMs <= Number(queryThresholdMs)
        && p95.projectionRebuildMs <= Number(projectionRebuildThresholdMs),
    };
  } finally {
    database.close();
  }
}

module.exports = {
  measureCatalogPerformance,
};
