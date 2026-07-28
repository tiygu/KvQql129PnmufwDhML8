"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { canonicalJson } = require("./canonical-json");

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const UNNAMED_ITEM_TITLE = "未命名物品";
const FILTER_NAMES = [
  "status",
  "disposition",
  "reviewAction",
  "iconFreshness",
  "mergeChainId",
  "level",
  "itemType",
];
const SEARCH_FIELDS = [
  ["itemId", 0],
  ["confirmedName", 1],
  ["candidateName", 2],
  ["currentIconIdentifier", 3],
  ["historicalIconIdentifier", 4],
  ["mergeChainId", 5],
];

function nullableText(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function nullablePositiveInteger(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeSearch(value) {
  return nullableText(value)?.normalize("NFKC").replace(/\s+/g, " ").toLowerCase() || "";
}

function catalogQueryError(message, code, statusCode, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function titleFacts(object) {
  const effective = object.effectiveValue || {};
  const candidate = object.algorithmCandidate || {};
  const confirmedName = nullableText(object.humanValues?.name?.value)
    || (object.activeVersion?.origin === "human-review" ? nullableText(effective.name) : null);
  const candidateName = nullableText(candidate.name)
    || nullableText(candidate.displayName)
    || nullableText(candidate.title)
    || nullableText(candidate.description)
    || nullableText(candidate.descriptionKey);
  if (confirmedName) {
    return {
      displayTitle: confirmedName,
      displayTitleSource: "confirmed-name",
      confirmedName,
      candidateName,
    };
  }
  if (candidateName) {
    return {
      displayTitle: candidateName,
      displayTitleSource: "candidate-name",
      confirmedName: null,
      candidateName,
    };
  }
  return {
    displayTitle: UNNAMED_ITEM_TITLE,
    displayTitleSource: "presentation-fallback",
    confirmedName: null,
    candidateName: null,
  };
}

function identityFacts(object) {
  const effective = object.effectiveValue || {};
  const titles = titleFacts(object);
  const level = nullablePositiveInteger(effective.level);
  return {
    confirmedName: titles.confirmedName,
    candidateName: titles.candidateName,
    level,
    itemType: nullableText(effective.type ?? effective.itemType),
    mergeChainId: nullableText(effective.chainId ?? effective.mergeChainId),
    chainPosition: level,
  };
}

function iconSummary(object) {
  const selection = object.displayIcon || {};
  const selectedCandidate = selection.selectedCandidate || null;
  const selectedIcon = selection.selectedIcon || null;
  if (!selectedCandidate) {
    return {
      state: "missing",
      freshness: "missing",
      selectedCandidateId: null,
      url: null,
    };
  }
  return {
    state: selectedIcon ? "selected" : "unavailable",
    freshness: selectedCandidate.currency?.status || "unknown",
    selectedCandidateId: Number(selectedCandidate.id),
    url: selectedIcon ? `/api/catalog/icon/${selectedIcon.assetHash}` : null,
  };
}

function reviewSummary(object) {
  const reasons = object.reviewReasons || [];
  return {
    status: reasons.length ? "needs-review" : "clear",
    action: reasons.length ? "review" : null,
    reasonCount: reasons.length,
  };
}

function summaryFromObject(object) {
  const facts = titleFacts(object);
  const identity = identityFacts(object);
  const updatedAt = [
    object.updatedAt,
    ...(object.displayIcon?.candidates || []).map((candidate) => candidate.createdAt),
    ...(object.displayIcon?.history || []).map((entry) => entry.createdAt),
  ].filter(Boolean).sort().at(-1) || object.updatedAt;
  return {
    itemId: String(object.objectId),
    displayTitle: facts.displayTitle,
    displayTitleSource: facts.displayTitleSource,
    identity: {
      ...identity,
    },
    displayIcon: iconSummary(object),
    catalogState: {
      status: object.status,
      disposition: object.disposition,
    },
    review: reviewSummary(object),
    matchedFields: [],
    detailUrl: `/api/catalog/items/${encodeURIComponent(String(object.objectId))}`,
    updatedAt,
  };
}

function candidateSummary(candidate, selection) {
  const selected = Number(selection?.selectedCandidate?.id) === Number(candidate.id);
  const assetAvailable = !!candidate.filePath && fs.existsSync(candidate.filePath);
  return {
    candidateId: Number(candidate.id),
    sourceType: candidate.sourceType,
    runtimeIdentifier: nullableText(candidate.runtimeIdentifier),
    resourceUrl: nullableText(candidate.resourceUrl),
    currency: {
      status: candidate.currency?.status || "unknown",
      reason: candidate.currency?.reason || null,
    },
    selection: {
      selected,
      origin: selected ? selection.selectionOrigin || null : null,
      manualProtection: selected && selection.manualProtection === true,
    },
    superseded: candidate.superseded === true,
    assetAvailable,
    url: assetAvailable ? `/api/catalog/icon/${candidate.assetHash}` : null,
    acquiredAt: candidate.createdAt,
  };
}

function candidateGroups(object) {
  const candidates = (object.displayIcon?.candidates || [])
    .map((candidate) => candidateSummary(candidate, object.displayIcon));
  return {
    currentDisplay: candidates.filter((candidate) => candidate.selection.selected),
    eligible: candidates.filter((candidate) => !candidate.selection.selected
      && !candidate.superseded && candidate.currency.status === "current"),
    historical: candidates.filter((candidate) => !candidate.selection.selected
      && (candidate.superseded || candidate.currency.status !== "current")),
  };
}

function searchDocument(object, summary) {
  const candidates = object.displayIcon?.candidates || [];
  const iconIdentifiers = (candidate) => [
    nullableText(candidate?.runtimeIdentifier),
    nullableText(candidate?.resourceUrl),
  ].filter(Boolean);
  const currentCandidates = candidates.filter((candidate) =>
    candidate.superseded !== true && candidate.currency?.status === "current");
  const historicalCandidates = candidates.filter((candidate) =>
    candidate.superseded === true || candidate.currency?.status !== "current");
  const currentIdentifiers = new Set([
    nullableText(object.effectiveValue?.iconResourceIdentifier),
    nullableText(object.effectiveValue?.iconResource),
    ...currentCandidates.flatMap(iconIdentifiers),
  ].filter(Boolean));
  const historicSemanticIdentifiers = [
    ...(object.versions || []).flatMap((version) => [
      nullableText(version.payload?.iconResourceIdentifier),
      nullableText(version.payload?.iconResource),
    ]),
    ...(object.evidence || []).flatMap((evidence) => [
      nullableText(evidence.payload?.iconResourceIdentifier),
      nullableText(evidence.payload?.iconResource),
    ]),
  ].filter((value) => value && !currentIdentifiers.has(value));
  return {
    itemId: [summary.itemId],
    confirmedName: [summary.identity.confirmedName].filter(Boolean),
    candidateName: [summary.identity.candidateName].filter(Boolean),
    currentIconIdentifier: [
      ...currentCandidates.flatMap(iconIdentifiers),
      nullableText(object.effectiveValue?.iconResourceIdentifier),
      nullableText(object.effectiveValue?.iconResource),
    ].filter(Boolean),
    historicalIconIdentifier: [
      ...historicalCandidates.flatMap(iconIdentifiers),
      ...historicSemanticIdentifiers,
    ],
    mergeChainId: [summary.identity.mergeChainId].filter(Boolean),
  };
}

function matchDocument(document, query) {
  let best = null;
  const fields = [];
  for (const [field, fieldPriority] of SEARCH_FIELDS) {
    let fieldMatched = false;
    for (const value of document[field] || []) {
      const normalized = normalizeSearch(value);
      const matchClass = normalized === query ? 0 : normalized.startsWith(query) ? 1 : normalized.includes(query) ? 2 : null;
      if (matchClass == null) continue;
      fieldMatched = true;
      const rank = [matchClass, fieldPriority];
      if (!best || rank[0] < best[0] || (rank[0] === best[0] && rank[1] < best[1])) best = rank;
    }
    if (fieldMatched) fields.push(field);
  }
  return best ? { rank: best, fields } : null;
}

function nullableCompare(left, right, compare) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return compare(left, right);
}

function compareItems(left, right, { query, sort, direction }) {
  let result = 0;
  if (query && sort === "relevance") {
    result = left.match.rank[0] - right.match.rank[0]
      || left.match.rank[1] - right.match.rank[1];
  } else if (sort === "chain-level") {
    result = nullableCompare(
      left.summary.identity.mergeChainId,
      right.summary.identity.mergeChainId,
      (a, b) => a.localeCompare(b) * (direction === "desc" ? -1 : 1),
    ) || nullableCompare(
      left.summary.identity.level,
      right.summary.identity.level,
      (a, b) => (a - b) * (direction === "desc" ? -1 : 1),
    );
  } else if (sort === "updated-at") {
    result = nullableCompare(
      left.summary.updatedAt,
      right.summary.updatedAt,
      (a, b) => a.localeCompare(b) * (direction === "desc" ? -1 : 1),
    );
  } else {
    result = left.summary.displayTitle.localeCompare(right.summary.displayTitle)
      * (direction === "desc" ? -1 : 1);
  }
  return result || left.summary.itemId.localeCompare(right.summary.itemId);
}

function queryValues(searchParams, name) {
  return searchParams.getAll(name)
    .flatMap((value) => value.split(","))
    .map((value) => nullableText(value))
    .filter(Boolean);
}

function matchesNullable(value, accepted) {
  if (!accepted.length) return true;
  return accepted.some((candidate) => candidate === "unknown"
    ? value == null || String(value) === "unknown"
    : String(value) === candidate);
}

function normalizeFilters(filters = {}) {
  return Object.fromEntries(FILTER_NAMES.map((name) => [
    name,
    [...new Set((Array.isArray(filters[name]) ? filters[name] : [])
      .map((value) => String(value).trim())
      .filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, "en")),
  ]));
}

function normalizeOptions(input = {}) {
  const scope = input.scope || "all";
  if (!["all", "pending"].includes(scope)) {
    throw catalogQueryError("invalid catalog query scope", "CATALOG_QUERY_INVALID_SCOPE", 400);
  }
  const query = normalizeSearch(input.query);
  if (query && scope === "pending") {
    throw catalogQueryError(
      "catalog-query-incompatible-scope",
      "CATALOG_QUERY_INCOMPATIBLE_SCOPE",
      400,
    );
  }
  const pageSize = input.pageSize == null || input.pageSize === ""
    ? DEFAULT_PAGE_SIZE
    : Number(input.pageSize);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw catalogQueryError("catalog-query-invalid-page-size", "CATALOG_QUERY_INVALID_PAGE_SIZE", 400, {
      minimum: 1,
      maximum: MAX_PAGE_SIZE,
    });
  }
  const sort = input.sort || (query ? "relevance" : "display-title");
  if (!["relevance", "display-title", "chain-level", "updated-at"].includes(sort)
    || (sort === "relevance" && !query)) {
    throw catalogQueryError("catalog-query-invalid-sort", "CATALOG_QUERY_INVALID_SORT", 400);
  }
  const direction = input.direction || "asc";
  if (!["asc", "desc"].includes(direction)) {
    throw catalogQueryError("catalog-query-invalid-direction", "CATALOG_QUERY_INVALID_DIRECTION", 400);
  }
  if (sort === "relevance" && direction !== "asc") {
    throw catalogQueryError("catalog-query-invalid-direction", "CATALOG_QUERY_INVALID_DIRECTION", 400);
  }
  return {
    scope,
    query,
    pageSize,
    sort,
    direction,
    cursor: input.cursor || null,
    filters: normalizeFilters(input.filters),
  };
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value) {
  try {
    const decoded = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object") throw new Error("invalid cursor");
    return decoded;
  } catch (_) {
    throw catalogQueryError("catalog-query-invalid-cursor", "CATALOG_QUERY_INVALID_CURSOR", 400);
  }
}

function querySignature(options) {
  return crypto.createHash("sha256").update(canonicalJson({
    scope: options.scope,
    query: options.query,
    pageSize: options.pageSize,
    sort: options.sort,
    direction: options.direction,
    filters: options.filters,
  })).digest("hex");
}

function orderingTuple(entry, options) {
  if (options.query && options.sort === "relevance") return entry.match.rank;
  if (options.sort === "chain-level") {
    return [entry.summary.identity.mergeChainId, entry.summary.identity.level];
  }
  if (options.sort === "updated-at") return [entry.summary.updatedAt];
  return [entry.summary.displayTitle];
}

class CatalogItemQuery {
  constructor(database) {
    this.database = database;
    this.cachedSnapshot = null;
  }

  _snapshot() {
    const latestSourceRevision = this.database.getCatalogQueryRevision();
    if (this.cachedSnapshot?.sourceRevision === latestSourceRevision) return this.cachedSnapshot;
    const snapshot = this.database.transaction(() => {
      const sourceRevision = this.database.getCatalogQueryRevision();
      const objects = this.database.listCatalogObjects({ objectType: "item-identity" })
        .map((entry) => this.database.getCatalogObject(entry.objectType, entry.objectId))
        .filter(Boolean);
      const entries = objects.map((object) => {
        const summary = summaryFromObject(object);
        return {
          object,
          summary,
          search: searchDocument(object, summary),
        };
      });
      const projectionRevision = crypto.createHash("sha256").update(canonicalJson(
        entries.map(({ summary, search }) => ({ summary, search })),
      )).digest("hex");
      const relations = this.database.listCatalogObjects({ objectType: "merge-relation" })
        .map((entry) => this.database.getCatalogObject(entry.objectType, entry.objectId))
        .filter(Boolean);
      const productionProfiles = this.database.listCatalogObjects({ objectType: "production-profile" })
        .map((entry) => this.database.getCatalogObject(entry.objectType, entry.objectId))
        .filter(Boolean);
      return {
        sourceRevision,
        revision: `catalog-query-v1:${projectionRevision}`,
        entries,
        byItemId: new Map(entries.map((entry) => [entry.summary.itemId, entry])),
        relations,
        productionProfiles,
      };
    });
    this.cachedSnapshot = snapshot;
    return snapshot;
  }

  revision() {
    return this._snapshot().revision;
  }

  list(input = {}) {
    const options = normalizeOptions(input);
    const snapshot = this._snapshot();
    const signature = querySignature(options);
    let offset = 0;
    let decodedCursor = null;
    if (options.cursor) {
      decodedCursor = decodeCursor(options.cursor);
      if (decodedCursor.revision !== snapshot.revision) {
        throw catalogQueryError(
          "catalog query revision changed",
          "CATALOG_QUERY_REVISION_CHANGED",
          409,
          { catalogQueryRevision: snapshot.revision },
        );
      }
      if (decodedCursor.signature !== signature
        || !Number.isInteger(decodedCursor.offset) || decodedCursor.offset < 1
        || !decodedCursor.lastItemId || !Array.isArray(decodedCursor.orderingTuple)) {
        throw catalogQueryError("catalog cursor mismatch", "CATALOG_CURSOR_MISMATCH", 400);
      }
      offset = decodedCursor.offset;
    }
    const filters = options.filters;
    const matched = snapshot.entries.flatMap((entry) => {
      if (options.scope === "pending" && entry.summary.review.status !== "needs-review") return [];
      if (!matchesNullable(entry.summary.catalogState.status, filters.status || [])) return [];
      if (!matchesNullable(entry.summary.catalogState.disposition, filters.disposition || [])) return [];
      if (!matchesNullable(entry.summary.review.action, filters.reviewAction || [])) return [];
      if (!matchesNullable(entry.summary.displayIcon.freshness, filters.iconFreshness || [])) return [];
      if (!matchesNullable(entry.summary.identity.mergeChainId, filters.mergeChainId || [])) return [];
      if (!matchesNullable(entry.summary.identity.level, filters.level || [])) return [];
      if (!matchesNullable(entry.summary.identity.itemType, filters.itemType || [])) return [];
      const match = options.query ? matchDocument(entry.search, options.query) : { rank: [0, 0], fields: [] };
      return match ? [{ ...entry, match }] : [];
    }).sort((left, right) => compareItems(left, right, options));
    if (decodedCursor) {
      const boundary = matched[offset - 1];
      if (!boundary
        || boundary.summary.itemId !== decodedCursor.lastItemId
        || canonicalJson(orderingTuple(boundary, options)) !== canonicalJson(decodedCursor.orderingTuple)) {
        throw catalogQueryError("catalog cursor mismatch", "CATALOG_CURSOR_MISMATCH", 400);
      }
    }
    const page = matched.slice(offset, offset + options.pageSize);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < matched.length;
    return {
      catalogQueryRevision: snapshot.revision,
      scope: options.scope,
      query: options.query || null,
      total: matched.length,
      returnedCount: page.length,
      pageSize: options.pageSize,
      hasMore,
      nextCursor: hasMore ? encodeCursor({
        revision: snapshot.revision,
        signature,
        offset: nextOffset,
        lastItemId: page.at(-1)?.summary.itemId || null,
        orderingTuple: page.length ? orderingTuple(page.at(-1), options) : [],
      }) : null,
      items: page.map((entry) => ({
        ...entry.summary,
        matchedFields: entry.match.fields,
      })),
    };
  }

  detail(itemId) {
    const snapshot = this._snapshot();
    const entry = snapshot.byItemId.get(String(itemId));
    if (!entry) {
      throw catalogQueryError("catalog-item-not-found", "CATALOG_ITEM_NOT_FOUND", 404, {
        itemId: String(itemId),
      });
    }
    const effective = entry.object.effectiveValue || {};
    const identity = identityFacts(entry.object);
    const chainId = entry.summary.identity.mergeChainId;
    const chainMembers = chainId == null ? [] : snapshot.entries
      .filter((candidate) => candidate.summary.identity.mergeChainId === chainId)
      .sort((left, right) => nullableCompare(
        left.summary.identity.level,
        right.summary.identity.level,
        (a, b) => a - b,
      ) || left.summary.itemId.localeCompare(right.summary.itemId))
      .map((candidate) => ({
        itemId: candidate.summary.itemId,
        displayTitle: candidate.summary.displayTitle,
        level: candidate.summary.identity.level,
        detailUrl: candidate.summary.detailUrl,
      }));
    const mergeRelations = snapshot.relations.flatMap((relation) => {
      const value = relation.effectiveValue || relation.algorithmCandidate || {};
      const sourceItemId = String(value.itemId ?? relation.objectId);
      const targetItemId = value.mergeTarget == null ? null : String(value.mergeTarget);
      return sourceItemId === entry.summary.itemId || targetItemId === entry.summary.itemId
        ? [{
            relationId: relation.objectId,
            sourceItemId,
            targetItemId,
            requiredCount: nullablePositiveInteger(value.requiredCount),
          }]
        : [];
    });
    const production = snapshot.productionProfiles.flatMap((profile) => {
      const value = profile.effectiveValue || profile.algorithmCandidate || {};
      const producerItemId = String(value.producerItemId ?? profile.objectId);
      const outputs = (value.candidateOutputs || []).map(String);
      return producerItemId === entry.summary.itemId || outputs.includes(entry.summary.itemId)
        ? [{ profileId: profile.objectId, producerItemId, outputItemIds: outputs }]
        : [];
    });
    const canEnterSemanticReview = entry.summary.review.status === "needs-review";
    return {
      catalogQueryRevision: snapshot.revision,
      readOnly: true,
      summary: entry.summary,
      identity: {
        itemId: entry.summary.itemId,
        confirmedName: identity.confirmedName,
        candidateName: identity.candidateName,
        effectiveFacts: {
          name: nullableText(effective.name),
          level: identity.level,
          itemType: identity.itemType,
          mergeChainId: identity.mergeChainId,
        },
      },
      relationships: {
        mergeChain: { mergeChainId: chainId, members: chainMembers },
        mergeRelations,
        production,
      },
      displayIcon: {
        selection: {
          revision: Number(entry.object.displayIcon?.revision || 1),
          origin: entry.object.displayIcon?.selectionOrigin || null,
          manualProtection: entry.object.displayIcon?.manualProtection === true,
          protectedEmpty: entry.object.displayIcon?.protectedEmpty === true,
        },
        candidates: candidateGroups(entry.object),
      },
      review: {
        ...entry.summary.review,
        reasons: (entry.object.reviewReasons || []).map((reason) => ({
          type: reason.type,
          message: reason.message || null,
        })),
      },
      capabilities: {
        canView: true,
        canEnterSemanticReview,
        semanticReviewUrl: canEnterSemanticReview
          ? `/api/catalog/object?type=item-identity&id=${encodeURIComponent(entry.summary.itemId)}`
          : null,
      },
    };
  }

  static fromSearchParams(searchParams) {
    return {
      scope: searchParams.get("scope") || "all",
      query: searchParams.get("q") || "",
      pageSize: searchParams.get("pageSize"),
      cursor: searchParams.get("cursor"),
      sort: searchParams.get("sort") || null,
      direction: searchParams.get("direction") || null,
      filters: Object.fromEntries(FILTER_NAMES.map((name) => [
        name,
        queryValues(searchParams, name),
      ])),
    };
  }
}

module.exports = {
  CatalogItemQuery,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  normalizeSearch,
};
