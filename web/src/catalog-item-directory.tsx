import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, Copy, History, Image as ImageIcon } from "lucide-react";
import { controlApi } from "./control-api";

function deepLinkedCatalogItemId() {
  try { return new URLSearchParams(globalThis.location?.search || "").get("itemId"); }
  catch (_) { return null; }
}

function writeCatalogItemDeepLink(itemId: string | null, { push = false } = {}) {
  try {
    const url = new URL(globalThis.location.href);
    if (itemId) url.searchParams.set("itemId", itemId);
    else url.searchParams.delete("itemId");
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    if (push) globalThis.history.pushState(null, "", nextUrl);
    else globalThis.history.replaceState(null, "", nextUrl);
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
  const initialItemId = useRef(deepLinkedCatalogItemId());
  const [scope, setScope] = useState<"pending" | "all">(initialItemId.current ? "all" : "pending");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(initialItemId.current);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const directoryMode = scope === "all" || search.trim().length > 0;

  useEffect(() => {
    if (!forcePendingKey) return;
    setScope("pending");
    setSearch("");
  }, [forcePendingKey]);

  useEffect(() => {
    const restoreDeepLink = () => {
      const itemId = deepLinkedCatalogItemId();
      setSelectedItemId(itemId);
      if (itemId) setScope("all");
    };
    globalThis.addEventListener?.("popstate", restoreDeepLink);
    return () => globalThis.removeEventListener?.("popstate", restoreDeepLink);
  }, []);

  useEffect(() => {
    if (!directoryMode) return;
    let active = true;
    setPage(null);
    setLoading(true);
    setError("");
    controlApi.getCatalogItems({ query: search, scope: "all", pageSize: 200 }).then((value) => {
      if (active) setPage(value);
    }).catch((requestError: any) => {
      if (active) {
        setPage(null);
        setError(requestError.message || "完整物品目录加载失败");
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [directoryMode, refreshRevision, search]);

  useEffect(() => {
    if (!directoryMode || !selectedItemId) {
      setDetail(null);
      setDetailError("");
      setDetailLoading(false);
      return;
    }
    let active = true;
    setDetail(null);
    setDetailLoading(true);
    setDetailError("");
    controlApi.getCatalogItem(selectedItemId).then((value) => {
      if (active) setDetail(value);
    }).catch((requestError: any) => {
      if (active) {
        setDetail(null);
        setDetailError(requestError.message || "物品详情加载失败");
      }
    }).finally(() => {
      if (active) setDetailLoading(false);
    });
    return () => { active = false; };
  }, [directoryMode, refreshRevision, selectedItemId]);

  const selectItem = (itemId: string, { push = false } = {}) => {
    setSelectedItemId(itemId);
    writeCatalogItemDeepLink(itemId, { push });
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
    setLoading(true);
    setError("");
    try {
      const next = await controlApi.getCatalogItems({
        query: search,
        scope: "all",
        pageSize: 200,
        cursor: page.nextCursor,
      });
      setPage((current: any) => ({
        ...next,
        returnedCount: Number(current?.returnedCount || 0) + Number(next.returnedCount || 0),
        items: [...(current?.items || []), ...(next.items || [])],
      }));
    } catch (requestError: any) {
      if (requestError.payload?.code === "CATALOG_QUERY_REVISION_CHANGED") {
        setPage(null);
        try {
          setPage(await controlApi.getCatalogItems({ query: search, scope: "all", pageSize: 200 }));
        } catch (reloadError: any) {
          setError(reloadError.message || "目录 revision 更新后重新加载失败");
        }
      } else {
        setError(requestError.message || "更多目录结果加载失败");
      }
    } finally {
      setLoading(false);
    }
  };

  const enterSemanticReview = () => {
    if (!detail?.capabilities?.canEnterSemanticReview) return;
    onEnterSemanticReview(detail.summary.itemId);
    setSearch("");
    setScope("pending");
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
          onChange={(event) => setSearch(event.target.value)}
          placeholder="名称、Item ID、图标资源或合成链"
        />
      </label>
      <div className="catalog-scope-switch" aria-label="目录范围">
        <button
          className={!directoryMode ? "active" : ""}
          onClick={() => { setSearch(""); setScope("pending"); }}
        >待处理 <b>{pendingCount}</b></button>
        <button className={directoryMode ? "active" : ""} onClick={() => setScope("all")}>
          全部物品 <b>{page?.total ?? itemIdentityCount}</b>
        </button>
      </div>
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
            : <div className="review-queue-list">{page?.items?.length ? page.items.map((item: any) => <article
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
                {item.matchedFields?.length > 0 && <small className="directory-match-reason">匹配：{item.matchedFields.join("、")}</small>}
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
            ? <div className="empty-state" role="alert"><AlertTriangle/><strong>物品详情不可用</strong><span>Item ID：{selectedItemId}</span><span>{detailError}</span></div>
            : !detail
              ? <div className="empty-state"><History/><strong>选择物品查看只读详情</strong><span>进入全部物品不会隐式选择任何 Item Identity。</span></div>
              : <>
                <div className="panel-head">
                  <div><span className="eyebrow">只读 Item Identity 详情</span><h2>{detail.summary.displayTitle}</h2><small>{detail.summary.itemId}</small></div>
                  {detail.capabilities.canEnterSemanticReview
                    ? <button className="ghost-btn" onClick={enterSemanticReview}>显式进入语义审核</button>
                    : <span className="object-disposition-badge">当前无需语义审核</span>}
                </div>
                {page?.items && !page.items.some((item: any) => item.itemId === detail.summary.itemId) && (
                  <p className="directory-selection-note">当前详情不符合正在使用的筛选条件，仍保留已选 Item Identity；清除搜索即可返回它。</p>
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
                      onClick={() => selectItem(member.itemId, { push: true })}
                      className={member.itemId === detail.summary.itemId ? "active" : ""}
                    >{member.displayTitle}<small>{member.level == null ? "等级未知" : `L${member.level}`}</small></button>)
                    : <p>没有已知合成链关系。</p>}</div>
                </section>
                <section className="directory-relationships">
                  <h3>合成关系</h3>
                  {detail.relationships.mergeRelations.length
                    ? detail.relationships.mergeRelations.map((relation: any) => <div className="directory-relation-row" key={relation.relationId}>
                      <span>{relation.sourceItemId} → {relation.targetItemId || "未知目标"} · {relation.requiredCount ?? "数量未知"}</span>
                      {[relation.sourceItemId, relation.targetItemId].filter(Boolean).map((itemId: string) => <button key={itemId} onClick={() => selectItem(itemId, { push: true })}>查看 {itemId}</button>)}
                    </div>)
                    : <p>没有已知合成关系。</p>}
                </section>
                <section className="directory-relationships">
                  <h3>产出关系</h3>
                  {detail.relationships.production.length
                    ? detail.relationships.production.map((profile: any) => <div className="directory-relation-row" key={profile.profileId}>
                      <span>{profile.profileId} · 产出 {profile.outputItemIds.length} 项</span>
                      {[profile.producerItemId, ...profile.outputItemIds].filter(Boolean).map((itemId: string) => <button key={itemId} onClick={() => selectItem(itemId, { push: true })}>查看 {itemId}</button>)}
                    </div>)
                    : <p>没有已知产出关系。</p>}
                </section>
                <p className="directory-readonly-note">浏览详情不会提交裁决、改变展示图标或进入编辑状态。</p>
              </>}
      </div>
    </> : children}
  </section>;
}
