import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, Copy, History, Image as ImageIcon } from "lucide-react";
import {
  controlApi,
  type CatalogCursor,
  type CatalogItemFilterName,
  type CatalogItemQueryPage,
  type CatalogItemQueryInput,
  type CatalogQueryRevision,
  type CatalogItemSort,
  type CatalogItemSortDirection,
} from "./control-api";
import "./catalog-item-directory.css";

type CatalogFilters = Record<CatalogItemFilterName, string[]>;
type CatalogDirectoryScope = "pending" | "all";
type CatalogDirectoryContext = {
  scope: CatalogDirectoryScope;
  search: string;
  sort: CatalogItemSort;
  direction: CatalogItemSortDirection;
  filters: CatalogFilters;
  loadedCount: number;
  listScrollTop: number;
};
type CatalogItemDirectoryHistoryState = {
  context?: CatalogDirectoryContext;
  focusDetail?: boolean;
  focusRelatedItemId?: string;
};

const filterControls: Array<{
  name: CatalogItemFilterName;
  label: string;
  placeholder: string;
}> = [
  { name: "status", label: "目录状态筛选", placeholder: "active, provisional, observed" },
  { name: "disposition", label: "处置状态筛选", placeholder: "enabled, paused" },
  { name: "reviewAction", label: "审核动作筛选", placeholder: "review, unknown" },
  { name: "iconFreshness", label: "图标时效筛选", placeholder: "current, stale, missing, unknown" },
  { name: "mergeChainId", label: "合成链筛选", placeholder: "链标识或 unknown" },
  { name: "level", label: "等级筛选", placeholder: "1, 2, unknown" },
  { name: "itemType", label: "物品类型筛选", placeholder: "flower, generator, unknown" },
];

const emptyFilters = (): CatalogFilters => Object.fromEntries(
  filterControls.map(({ name }) => [name, []]),
) as CatalogFilters;

const matchedFieldLabels: Record<string, string> = {
  itemId: "Item ID",
  confirmedName: "确认名称",
  candidateName: "候选名称",
  currentIconIdentifier: "当前图标标识",
  historicalIconIdentifier: "历史图标标识",
  mergeChainId: "合成链标识",
};

const catalogItemSorts: CatalogItemSort[] = [
  "relevance",
  "display-title",
  "chain-level",
  "updated-at",
];

function parseFilterValues(value: string) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function formatFilterValues(values: string[]) {
  return values.join(", ");
}

function cloneFilters(filters: CatalogFilters) {
  return Object.fromEntries(
    Object.entries(filters).map(([name, values]) => [name, [...values]]),
  ) as CatalogFilters;
}

function readCatalogItemDirectoryHistoryState(
  value = globalThis.history?.state,
): CatalogItemDirectoryHistoryState | null {
  const state = value?.catalogItemDirectory;
  if (!state || typeof state !== "object") return null;
  const sourceContext = state.context;
  let context: CatalogDirectoryContext | undefined;
  if (sourceContext && typeof sourceContext === "object") {
    const restoredFilters = emptyFilters();
    for (const { name } of filterControls) {
      const values = sourceContext.filters?.[name];
      if (Array.isArray(values)) {
        restoredFilters[name] = values.filter((entry: unknown) => typeof entry === "string");
      }
    }
    context = {
      scope: sourceContext.scope === "pending" ? "pending" : "all",
      search: typeof sourceContext.search === "string" ? sourceContext.search : "",
      sort: catalogItemSorts.includes(sourceContext.sort)
        ? sourceContext.sort
        : "display-title",
      direction: sourceContext.direction === "desc" ? "desc" : "asc",
      filters: restoredFilters,
      loadedCount: Number.isSafeInteger(sourceContext.loadedCount)
        ? Math.max(0, sourceContext.loadedCount)
        : 0,
      listScrollTop: Number.isFinite(sourceContext.listScrollTop)
        ? Math.max(0, sourceContext.listScrollTop)
        : 0,
    };
  }
  return {
    context,
    focusDetail: !!state.focusDetail,
    focusRelatedItemId: typeof state.focusRelatedItemId === "string"
      ? state.focusRelatedItemId
      : undefined,
  };
}

function deepLinkedCatalogItemId() {
  try { return new URLSearchParams(globalThis.location?.search || "").get("itemId"); }
  catch (_) { return null; }
}

function writeCatalogItemDeepLink(
  itemId: string | null,
  {
    push = false,
    navigationState = null,
  }: {
    push?: boolean;
    navigationState?: CatalogItemDirectoryHistoryState | null;
  } = {},
) {
  try {
    const url = new URL(globalThis.location.href);
    if (itemId) url.searchParams.set("itemId", itemId);
    else url.searchParams.delete("itemId");
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    const currentState = globalThis.history.state;
    const nextState = currentState && typeof currentState === "object"
      ? { ...currentState }
      : {};
    if (navigationState) nextState.catalogItemDirectory = navigationState;
    else delete nextState.catalogItemDirectory;
    if (push) globalThis.history.pushState(nextState, "", nextUrl);
    else globalThis.history.replaceState(nextState, "", nextUrl);
  } catch (_) {}
}

export function CatalogItemDirectory({
  itemIdentityCount,
  refreshRevision,
  pendingCount,
  forcePendingKey,
  onEnterSemanticReview,
  children,
}: {
  itemIdentityCount: number;
  refreshRevision: string | number;
  pendingCount: number;
  forcePendingKey: string | null;
  onEnterSemanticReview: (itemId: string) => void;
  children: ReactNode;
}) {
  const directoryRef = useRef<HTMLElement | null>(null);
  const directoryListRef = useRef<HTMLDivElement | null>(null);
  const initialItemId = useRef(deepLinkedCatalogItemId());
  const initialNavigationState = useRef(readCatalogItemDirectoryHistoryState());
  const initialContext = initialNavigationState.current?.context;
  const [scope, setScope] = useState<CatalogDirectoryScope>(
    initialContext?.scope || (initialItemId.current ? "all" : "pending"),
  );
  const [search, setSearch] = useState(initialContext?.search || "");
  const [sort, setSort] = useState<CatalogItemSort>(
    initialContext?.sort || "display-title",
  );
  const [direction, setDirection] = useState<CatalogItemSortDirection>(
    initialContext?.direction || "asc",
  );
  const [filters, setFilters] = useState<CatalogFilters>(
    initialContext ? cloneFilters(initialContext.filters) : emptyFilters,
  );
  const [page, setPage] = useState<CatalogItemQueryPage | null>(null);
  const [publishedQueryRevision, setPublishedQueryRevision] =
    useState<CatalogQueryRevision | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(initialItemId.current);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailErrorCode, setDetailErrorCode] = useState("");
  const directoryRequestId = useRef(0);
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const focusDetailAfterLoad = useRef(!!initialNavigationState.current?.focusDetail);
  const pendingRelatedItemFocus = useRef<string | null>(
    initialNavigationState.current?.focusRelatedItemId || null,
  );
  const restoreLoadedCount = useRef(initialContext?.loadedCount || 0);
  const visibleResultCount = useRef(initialContext?.loadedCount || 0);
  const pendingListScrollTop = useRef<number | null>(
    initialContext ? initialContext.listScrollTop : null,
  );
  const preSearchState = useRef<{
    scope: "pending" | "all";
    sort: CatalogItemSort;
    direction: CatalogItemSortDirection;
    filters: CatalogFilters;
  } | null>(null);
  const directoryMode = scope === "all" || search.trim().length > 0;
  const filterSignature = JSON.stringify(filters);
  const queryIdentity = JSON.stringify({
    scope,
    query: search,
    sort,
    direction,
    filters,
  });
  const queryIdentityRef = useRef(queryIdentity);
  const lastFetchedQueryIdentity = useRef(queryIdentity);
  const activeQueryRevision = useRef<CatalogQueryRevision | null>(
    page?.catalogQueryRevision || publishedQueryRevision,
  );
  queryIdentityRef.current = queryIdentity;
  activeQueryRevision.current = page?.catalogQueryRevision || publishedQueryRevision;
  if (page) visibleResultCount.current = page.items.length;
  const currentQueryInput = (
    cursor: CatalogCursor | null = null,
    loadedCount = 0,
  ): CatalogItemQueryInput => ({
    query: search,
    scope: "all",
    pageSize: 200,
    cursor,
    sort,
    direction,
    filters,
    loadedCount,
    selectedItemId,
  });
  const captureDirectoryScroll = () => {
    if (pendingListScrollTop.current == null && directoryListRef.current) {
      pendingListScrollTop.current = directoryListRef.current.scrollTop;
    }
  };

  useEffect(() => {
    if (!forcePendingKey) return;
    restoreLoadedCount.current = 0;
    visibleResultCount.current = 0;
    pendingListScrollTop.current = null;
    const previous = preSearchState.current;
    preSearchState.current = null;
    setScope("pending");
    setSearch("");
    if (previous) {
      setSort(previous.sort);
      setDirection(previous.direction);
      setFilters(previous.filters);
    } else if (sort === "relevance") {
      setSort("display-title");
      setDirection("asc");
    }
  }, [forcePendingKey]);

  useEffect(() => {
    const restoreDeepLink = (event: PopStateEvent) => {
      const itemId = deepLinkedCatalogItemId();
      const navigationState = readCatalogItemDirectoryHistoryState(event.state);
      focusDetailAfterLoad.current = !!navigationState?.focusDetail;
      pendingRelatedItemFocus.current = navigationState?.focusRelatedItemId || null;
      if (navigationState?.context) {
        const context = navigationState.context;
        restoreLoadedCount.current = context.loadedCount;
        pendingListScrollTop.current = context.listScrollTop;
        setScope(context.scope);
        setSearch(context.search);
        setSort(context.sort);
        setDirection(context.direction);
        setFilters(cloneFilters(context.filters));
      }
      setSelectedItemId(itemId);
      if (itemId && !navigationState?.context) setScope("all");
    };
    globalThis.addEventListener?.("popstate", restoreDeepLink);
    return () => globalThis.removeEventListener?.("popstate", restoreDeepLink);
  }, []);

  useEffect(() => controlApi.onEvent((event) => {
    if (!["catalog-query-updated", "control-connected"].includes(event?.type)) return;
    const revision = event.catalogQueryRevision || null;
    if (!revision || activeQueryRevision.current === revision) return;
    activeQueryRevision.current = revision;
    captureDirectoryScroll();
    setPage((current) =>
      current?.catalogQueryRevision === revision ? current : null);
    setPublishedQueryRevision((current) => current === revision ? current : revision);
  }), []);

  useEffect(() => {
    const requestId = ++directoryRequestId.current;
    if (!directoryMode) {
      setLoading(false);
      return;
    }
    let active = true;
    if (lastFetchedQueryIdentity.current === queryIdentity
      && pendingListScrollTop.current == null
      && directoryListRef.current) {
      pendingListScrollTop.current = directoryListRef.current.scrollTop;
    }
    lastFetchedQueryIdentity.current = queryIdentity;
    setPage(null);
    setLoading(true);
    setError("");
    const loadedCount = Math.max(
      restoreLoadedCount.current,
      visibleResultCount.current,
    );
    controlApi.getCatalogItems(currentQueryInput(null, loadedCount)).then((value) => {
      if (active && directoryRequestId.current === requestId) setPage(value);
    }).catch((requestError: any) => {
      if (active && directoryRequestId.current === requestId) {
        setPage(null);
        setError(requestError.message || "完整物品目录加载失败");
      }
    }).finally(() => {
      if (active && directoryRequestId.current === requestId) setLoading(false);
    });
    return () => { active = false; };
  }, [
    directoryMode,
    refreshRevision,
    publishedQueryRevision,
    search,
    sort,
    direction,
    filterSignature,
    selectedItemId,
  ]);

  useEffect(() => {
    if (!directoryMode || !selectedItemId) {
      setDetail(null);
      setDetailError("");
      setDetailErrorCode("");
      setDetailLoading(false);
      return;
    }
    let active = true;
    setDetail(null);
    setDetailLoading(true);
    setDetailError("");
    setDetailErrorCode("");
    controlApi.getCatalogItem(selectedItemId).then((value) => {
      if (active) setDetail(value);
    }).catch((requestError: any) => {
      if (active) {
        setDetail(null);
        setDetailError(requestError.message || "物品详情加载失败");
        setDetailErrorCode(requestError.payload?.code || "");
      }
    }).finally(() => {
      if (active) setDetailLoading(false);
    });
    return () => { active = false; };
  }, [directoryMode, refreshRevision, publishedQueryRevision, selectedItemId]);

  useEffect(() => {
    if (!page || loading || pendingListScrollTop.current == null) return;
    const frame = globalThis.requestAnimationFrame?.(() => {
      if (directoryListRef.current) {
        directoryListRef.current.scrollTop = pendingListScrollTop.current || 0;
      }
      pendingListScrollTop.current = null;
      restoreLoadedCount.current = 0;
    });
    return () => {
      if (frame != null) globalThis.cancelAnimationFrame?.(frame);
    };
  }, [loading, page]);

  useEffect(() => {
    if (!detail || detailLoading) return;
    const frame = globalThis.requestAnimationFrame?.(() => {
      if (focusDetailAfterLoad.current) {
        focusDetailAfterLoad.current = false;
        detailHeadingRef.current?.focus();
        return;
      }
      const relatedItemId = pendingRelatedItemFocus.current;
      if (!relatedItemId) return;
      pendingRelatedItemFocus.current = null;
      const candidates = directoryRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-related-item-id]",
      ) || [];
      [...candidates].find((candidate) =>
        candidate.dataset.relatedItemId === relatedItemId)?.focus();
    });
    return () => {
      if (frame != null) globalThis.cancelAnimationFrame?.(frame);
    };
  }, [detail, detailLoading]);

  const currentDirectoryContext = (): CatalogDirectoryContext => ({
    scope,
    search,
    sort,
    direction,
    filters: cloneFilters(filters),
    loadedCount: page?.items.length || 0,
    listScrollTop: directoryListRef.current?.scrollTop || 0,
  });

  const selectItem = (itemId: string, { push = false } = {}) => {
    const context = currentDirectoryContext();
    if (push) {
      writeCatalogItemDeepLink(selectedItemId, {
        navigationState: {
          context,
          focusRelatedItemId: itemId,
        },
      });
      focusDetailAfterLoad.current = true;
    }
    setSelectedItemId(itemId);
    writeCatalogItemDeepLink(itemId, {
      push,
      navigationState: {
        context,
        focusDetail: push,
      },
    });
  };

  const relationshipNavigationProps = (itemId: string) => ({
    "data-related-item-id": itemId,
    onClick: () => selectItem(itemId, { push: true }),
  });

  const resetRestoredDirectoryPosition = () => {
    restoreLoadedCount.current = 0;
    visibleResultCount.current = 0;
    pendingListScrollTop.current = null;
  };

  const restorePreSearchState = (nextScope?: "pending" | "all") => {
    const previous = preSearchState.current;
    preSearchState.current = null;
    if (previous) {
      setScope(nextScope || previous.scope);
      setSort(previous.sort);
      setDirection(previous.direction);
      setFilters(previous.filters);
    } else if (nextScope) {
      setScope(nextScope);
    }
  };

  const changeSearch = (value: string) => {
    resetRestoredDirectoryPosition();
    const hadQuery = search.trim().length > 0;
    const hasQuery = value.trim().length > 0;
    if (!hadQuery && hasQuery) {
      preSearchState.current = {
        scope,
        sort,
        direction,
        filters: Object.fromEntries(
          Object.entries(filters).map(([name, values]) => [name, [...values]]),
        ) as CatalogFilters,
      };
      setScope("all");
      setSort("relevance");
      setDirection("asc");
    } else if (hadQuery && !hasQuery) {
      restorePreSearchState();
    }
    setSearch(value);
  };

  const showPending = () => {
    resetRestoredDirectoryPosition();
    setSearch("");
    restorePreSearchState("pending");
  };

  const changeSort = (value: CatalogItemSort) => {
    resetRestoredDirectoryPosition();
    setSort(value);
    if (value === "relevance") setDirection("asc");
  };

  const changeFilter = (name: CatalogItemFilterName, value: string) => {
    resetRestoredDirectoryPosition();
    setFilters((current) => ({ ...current, [name]: parseFilterValues(value) }));
  };

  const moveRowFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = [...(directoryRef.current?.querySelectorAll<HTMLButtonElement>(".directory-item-select") || [])];
    const current = rows.indexOf(event.currentTarget);
    if (current < 0) return;
    rows[Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  const loadMore = async () => {
    if (!page?.nextCursor || loading) return;
    const requestId = ++directoryRequestId.current;
    const requestIdentity = queryIdentity;
    const requestCursor = page.nextCursor;
    const requestRevision = page.catalogQueryRevision;
    setLoading(true);
    setError("");
    try {
      const next = await controlApi.getCatalogItems(currentQueryInput(requestCursor));
      if (directoryRequestId.current !== requestId
        || queryIdentityRef.current !== requestIdentity) return;
      setPage((current: any) => {
        if (!current || current.catalogQueryRevision !== requestRevision
          || current.nextCursor !== requestCursor) return current;
        return {
          ...next,
          returnedCount: Number(current.returnedCount || 0) + Number(next.returnedCount || 0),
          items: [...(current.items || []), ...(next.items || [])],
        };
      });
    } catch (requestError: any) {
      if (directoryRequestId.current !== requestId
        || queryIdentityRef.current !== requestIdentity) return;
      if (requestError.payload?.code === "CATALOG_QUERY_REVISION_CHANGED") {
        captureDirectoryScroll();
        setPage(null);
        try {
          const restarted = await controlApi.getCatalogItems(
            currentQueryInput(null, visibleResultCount.current),
          );
          if (directoryRequestId.current !== requestId
            || queryIdentityRef.current !== requestIdentity) return;
          setPage(restarted);
        } catch (reloadError: any) {
          if (directoryRequestId.current !== requestId
            || queryIdentityRef.current !== requestIdentity) return;
          setError(reloadError.message || "目录 revision 更新后重新加载失败");
        }
      } else {
        setError(requestError.message || "更多目录结果加载失败");
      }
    } finally {
      if (directoryRequestId.current === requestId
        && queryIdentityRef.current === requestIdentity) setLoading(false);
    }
  };

  const enterSemanticReview = () => {
    if (!detail?.capabilities?.canEnterSemanticReview) return;
    onEnterSemanticReview(detail.summary.itemId);
    setSearch("");
    restorePreSearchState("pending");
    writeCatalogItemDeepLink(null);
  };

  return <section ref={directoryRef} className="catalog-review-workspace">
    <div className="catalog-directory-toolbar" role="search">
      <label>
        <span>搜索覆盖全部 Item Identity</span>
        <input
          type="search"
          aria-label="搜索全部物品"
          value={search}
          onChange={(event) => changeSearch(event.target.value)}
          placeholder="名称、Item ID、图标资源或合成链"
        />
      </label>
      <div className="catalog-scope-switch" aria-label="目录范围">
        <button
          className={!directoryMode ? "active" : ""}
          onClick={showPending}
        >待处理 <b>{pendingCount}</b></button>
        <button className={directoryMode ? "active" : ""} onClick={() => {
          resetRestoredDirectoryPosition();
          setScope("all");
        }}>
          全部物品 <b>{page?.total ?? itemIdentityCount}</b>
        </button>
      </div>
    </div>
    <div className="catalog-directory-query-controls" aria-label="目录筛选与排序">
      <label>
        <span>目录排序</span>
        <select
          aria-label="目录排序"
          value={sort}
          onChange={(event) => changeSort(event.target.value as CatalogItemSort)}
        >
          <option value="relevance" disabled={!search.trim()}>相关性</option>
          <option value="display-title">显示名称</option>
          <option value="chain-level">合成链与等级</option>
          <option value="updated-at">最后相关变更</option>
        </select>
      </label>
      <label>
        <span>排序方向</span>
        <select
          aria-label="排序方向"
          value={direction}
          disabled={sort === "relevance"}
          onChange={(event) => {
            resetRestoredDirectoryPosition();
            setDirection(event.target.value as CatalogItemSortDirection);
          }}
        >
          <option value="asc">升序</option>
          <option value="desc">降序</option>
        </select>
      </label>
      {filterControls.map((control) => <label key={control.name}>
        <span>{control.label}</span>
        <input
          aria-label={control.label}
          value={formatFilterValues(filters[control.name])}
          onChange={(event) => changeFilter(control.name, event.target.value)}
          placeholder={control.placeholder}
        />
      </label>)}
      <p>不同筛选字段按 AND 组合；同一输入内以逗号分隔的值按 OR 组合；使用 unknown 筛选未知值。</p>
    </div>
    {directoryMode ? <>
      <div className="panel review-queue catalog-directory-list">
        <div className="panel-head">
          <div><span className="eyebrow">{search.trim() ? "全部目录搜索" : "Catalog Repository"}</span><h2>{search.trim() ? "搜索结果" : "全部物品"}</h2></div>
          <b>{page?.total ?? "—"}</b>
        </div>
        <p className="review-help">每个 Item Identity 恰好占一行；列表由服务器排序，不会自动选择第一项。</p>
        {loading && !page
          ? <div className="empty-state compact"><History className="spin"/><span>正在读取完整目录…</span></div>
          : error
            ? <div className="empty-state compact" role="alert"><AlertTriangle/><span>{error}</span></div>
            : <div ref={directoryListRef} className="review-queue-list">{page?.items?.length ? page.items.map((item: any) => <article
              key={item.itemId}
              className={selectedItemId === item.itemId ? "active" : ""}
            >
              <button
                className="directory-item-select"
                aria-label={`${item.displayTitle} ${item.itemId}`}
                onClick={() => selectItem(item.itemId)}
                onKeyDown={moveRowFocus}
              >
                <span className={`directory-row-icon ${item.displayIcon.url ? "available" : "missing"}`}>
                  {item.displayIcon.url ? <img src={item.displayIcon.url} alt=""/> : <ImageIcon size={18}/>}
                </span>
                <span>
                  <strong>{item.displayTitle}</strong>
                  <small>{item.identity.level == null ? "等级未知" : `L${item.identity.level}`} · {item.identity.itemType || "类型未知"} · 链位 {item.identity.chainPosition ?? "未知"}</small>
                  <small>{item.displayTitleSource} · {item.displayIcon.freshness}</small>
                </span>
                <span className="directory-row-state">
                  <i>{item.catalogState.status}</i>
                </span>
                {item.matchedFields?.length > 0 && <small className="directory-match-reason">匹配：{item.matchedFields.map((field: string) => matchedFieldLabels[field] || field).join("、")}</small>}
              </button>
              <button
                className="directory-copy-id"
                aria-label={`复制 ${item.itemId}`}
                title={item.itemId}
                onClick={() => void globalThis.navigator?.clipboard?.writeText(item.itemId)}
              ><Copy size={13}/>{item.itemId.length > 12 ? `${item.itemId.slice(0, 8)}…${item.itemId.slice(-4)}` : item.itemId}</button>
            </article>) : <div className="empty-state compact"><History/><span>没有符合条件的 Item Identity</span></div>}
            {page?.hasMore && <button className="directory-load-more" disabled={loading} onClick={loadMore}>{loading ? "正在加载…" : "加载更多"}</button>}
            </div>}
      </div>
      <div className="panel review-detail catalog-directory-detail">
        {detailLoading
          ? <div className="empty-state"><History className="spin"/><strong>正在加载只读详情…</strong></div>
          : detailError
            ? detailErrorCode === "CATALOG_ITEM_NOT_FOUND"
              ? <div className="empty-state" role="alert" data-selection-status="not-found">
                <AlertTriangle/>
                <strong>Item Identity not found</strong>
                <span>{selectedItemId}</span>
                <span>该 Item ID 无效或已被删除，当前选择没有切换到其他物品。</span>
              </div>
              : <div className="empty-state" role="alert"><AlertTriangle/><strong>物品详情不可用</strong><span>Item ID：{selectedItemId}</span><span>{detailError}</span></div>
            : !detail
              ? <div className="empty-state"><History/><strong>选择物品查看只读详情</strong><span>进入全部物品不会隐式选择任何 Item Identity。</span></div>
              : <>
                <div className="panel-head">
                  <div>
                    <span className="eyebrow">只读 Item Identity 详情</span>
                    <h2 ref={detailHeadingRef} tabIndex={-1}>{detail.summary.displayTitle}</h2>
                    <small>{detail.summary.itemId}</small>
                  </div>
                  {detail.capabilities.canEnterSemanticReview
                    ? <button className="ghost-btn" onClick={enterSemanticReview}>显式进入语义审核</button>
                    : <span className="object-disposition-badge">当前无需语义审核</span>}
                </div>
                {page?.selectionInResults === false && (
                  <p className="directory-selection-note" role="status" data-selection-status="out-of-results">
                    <strong>结果范围外（out-of-results）</strong>
                    当前详情不符合正在使用的筛选条件，仍保留已选 Item Identity；清除搜索即可返回它。
                  </p>
                )}
                <div className="directory-facts">
                  <div><span>名称来源</span><strong>{detail.summary.displayTitleSource}</strong></div>
                  <div><span>等级</span><strong>{detail.identity.effectiveFacts.level ?? "未知"}</strong></div>
                  <div><span>类型</span><strong>{detail.identity.effectiveFacts.itemType || "未知"}</strong></div>
                  <div><span>合成链</span><strong>{detail.identity.effectiveFacts.mergeChainId || "未知"}</strong></div>
                  <div><span>目录状态</span><strong>{detail.summary.catalogState.status}</strong></div>
                  <div><span>图标证据</span><strong>{detail.summary.displayIcon.state === "missing" ? "缺失" : detail.summary.displayIcon.freshness}</strong></div>
                </div>
                <section className="directory-relationships">
                  <h3>合成链成员</h3>
                  <div>{detail.relationships.mergeChain.members.length
                    ? detail.relationships.mergeChain.members.map((member: any) => <button
                      key={member.itemId}
                      {...relationshipNavigationProps(member.itemId)}
                      className={member.itemId === detail.summary.itemId ? "active" : ""}
                    >{member.displayTitle}<small>{member.level == null ? "等级未知" : `L${member.level}`}</small></button>)
                    : <p>没有已知合成链关系。</p>}</div>
                </section>
                <section className="directory-relationships">
                  <h3>合成关系</h3>
                  {detail.relationships.mergeRelations.length
                    ? detail.relationships.mergeRelations.map((relation: any) => <div className="directory-relation-row" key={relation.relationId}>
                      <span>{relation.sourceItemId} → {relation.targetItemId || "未知目标"} · {relation.requiredCount ?? "数量未知"}</span>
                      {[relation.sourceItemId, relation.targetItemId].filter(Boolean).map((itemId: string) => <button key={itemId} {...relationshipNavigationProps(itemId)}>查看 {itemId}</button>)}
                    </div>)
                    : <p>没有已知合成关系。</p>}
                </section>
                <section className="directory-relationships">
                  <h3>产出关系</h3>
                  {detail.relationships.production.length
                    ? detail.relationships.production.map((profile: any) => <div className="directory-relation-row" key={profile.profileId}>
                      <span>{profile.profileId} · 产出 {profile.outputItemIds.length} 项</span>
                      {[profile.producerItemId, ...profile.outputItemIds].filter(Boolean).map((itemId: string) => <button key={itemId} {...relationshipNavigationProps(itemId)}>查看 {itemId}</button>)}
                    </div>)
                    : <p>没有已知产出关系。</p>}
                </section>
                <p className="directory-readonly-note">浏览详情不会提交裁决、改变展示图标或进入编辑状态。</p>
              </>}
      </div>
    </> : children}
  </section>;
}
