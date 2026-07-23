import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, Boxes, CircleDollarSign, ClipboardList, Database, Diamond, Download, Gauge, LayoutDashboard, Map, Pause, Play, RefreshCw, Route, ScrollText, Settings, Sparkles, Square, StepForward, Upload, X, Zap } from "lucide-react";
import { controlApi } from "./control-api";
import { CatalogReviewWorkspace } from "./CatalogReviewWorkspace";
import { ImageLightbox } from "./ImageLightbox";

type Tab = "overview" | "board" | "orders" | "catalog" | "map" | "logs";

const demo = {
  connected: false, running: false, paused: false,
  state: { scene: "map", resources: { coins: 208, diamonds: 70, energy: 19 }, energy: { limit: 100 }, board: { width: 7, height: 9, occupied: 44, empty: 19, grids: Array.from({ length: 63 }, (_, index) => ({ index, itemId: index % 5 === 0 ? String(10100020 + index % 12) : "", empty: index % 5 !== 0 })), mergeCandidates: [] }, orders: [], producers: [], mapMission: { id: "11001030", nextId: "11001031", canComplete: false, requirements: [{ resourceType: 1, current: 208, required: 324, deficit: 116 }] }, overlays: [] },
  plan: { energyAvailable: 19, plans: [], recommended: null }, catalog: { chains: 18, items: 121, producers: 29, drops: 108 }, catalogView: { chains: [], items: [], producers: [], repository: { summary: { states: { observed: 0, provisional: 0, active: 0 } }, objects: [] } }, actions: [], resourceSamples: [],
};

const tabs: { id: Tab; label: string; icon: any }[] = [
  { id: "overview", label: "总览", icon: LayoutDashboard }, { id: "board", label: "棋盘", icon: Boxes },
  { id: "orders", label: "订单", icon: ClipboardList }, { id: "catalog", label: "图鉴", icon: Database },
  { id: "map", label: "地图任务", icon: Map }, { id: "logs", label: "运行日志", icon: ScrollText },
];

const codeLabels: Record<string, string> = {
  unknown: "未知",
  feasible: "可行",
  blocked: "受阻",
  safe: "安全",
  active: "生效",
  provisional: "暂定",
  observed: "已观察",
  loaded: "已加载",
  unloaded: "未加载",
  available: "可用",
  unavailable: "不可用",
  enabled: "已启用",
  paused: "已暂停",
  automatic: "自动",
  observation: "观察",
  assisted: "辅助",
};

function codeLabel(value: any) {
  const text = String(value ?? "unknown");
  return codeLabels[text] || text;
}

function actionLabel(value: any) {
  const labels: Record<string, string> = {
    merge: "合成",
    produce: "产出",
    submit: "提交订单",
    "switch-production-mode": "切换产出档位",
    "warehouse-store": "存入仓库",
    "warehouse-retrieve": "取回仓库物品",
  };
  return labels[String(value)] || String(value || "待规划");
}

function localizedDetail(value: any) {
  return String(value ?? "")
    .replaceAll("no deterministic action", "暂无确定性动作")
    .replaceAll("automatic", "自动")
    .replaceAll("observation", "观察")
    .replaceAll("assisted", "辅助")
    .replaceAll("unknown", "未知")
    .replaceAll("unavailable", "不可用")
    .replaceAll("available", "可用")
    .replaceAll("safe", "安全")
    .replaceAll("blocked", "受阻");
}

function Board({ state, selectedIndex, onSelect, catalogItems = [], onImageClick }: any) {
  const width = state.board.width || 7, height = state.board.height || 9;
  const grids = state.board.grids?.length ? state.board.grids : demo.state.board.grids;
  const mergeSet = new Set((state.board.mergeCandidates || []).flatMap((x: any) => [x.from, x.to]));
  return <div className="board-wrap"><div className="board-grid" style={{ gridTemplateColumns: `repeat(${width}, 1fr)`, aspectRatio: `${width}/${height}` }}>
    {Array.from({ length: width * height }, (_, index) => { const grid = grids.find((x: any) => x.index === index) || { index, empty: true }; const code = Number(String(grid.itemId || "").slice(-2)) || index; const catalogItem = catalogItems.find((item: any) => String(item.id) === String(grid.itemId)); return <button key={index} onClick={() => onSelect?.(grid)} className={`board-cell ${grid.empty ? "empty" : "filled"} ${mergeSet.has(index) ? "mergeable" : ""} ${selectedIndex === index ? "selected" : ""}`}>
      {!grid.empty && <><div className={`item-gem ${catalogItem?.iconUrl ? "real-icon" : "missing-icon"}`} style={{ "--hue": `${(code * 37) % 360}` } as any}>{catalogItem?.iconUrl ? <img src={catalogItem.iconUrl} alt="" onClick={(e: any) => { e.stopPropagation(); onImageClick?.(catalogItem.iconUrl); }}/> : <Sparkles size={16}/>}</div><span>L{grid.level || "?"}</span></>}<small>{index}</small>
    </button>; })}
  </div><div className="board-legend"><span><i className="dot green"/>可安全合成</span><span><i className="dot gold"/>订单保留</span><span><i className="dot gray"/>空格</span></div></div>;
}

function Orders({ state, plan, mode, onSell, onPrioritize, onReviewEvidence, onScanEvidence }: any) {
  const plans = plan.plans || [];
  return <div className="order-list">
    {plan.status === "evidence-waiting" && <div className="evidence-waiting-banner"><AlertTriangle/><div><strong>正在等待图鉴证据</strong><span>所有订单都因图鉴证据缺失或未生效而受阻，请审核阻塞项或执行受控扫描。</span></div><button onClick={() => onScanEvidence?.(plan.evidenceBlocks?.flatMap((block: any) => block.blockers.map((item: any) => item.scanAction?.itemId).filter(Boolean)) || [])}>执行主动图鉴扫描</button></div>}
    {plan.warehouse && <div className="warehouse-planning"><strong>仓库清单状态：{codeLabel(plan.warehouse.inventoryKnowledge?.status)} {plan.warehouse.inventoryKnowledge?.revision ? `· 版本 ${plan.warehouse.inventoryKnowledge.revision}` : ""}</strong><span>{plan.warehouse.exchangeCapacity == null ? "容量未知。" : `有限交换容量：${plan.warehouse.exchangeCapacity} 个槽位。`} 棋盘供给 {plan.inventory?.boardSupply?.total || 0} · 仓库供给 {plan.inventory?.warehouseSupply?.total || 0} · 不可用 {plan.inventory?.unavailableSupply?.total || 0}。</span>{plan.warehouseInventoryLoadRequired && <small>需要先加载仓库清单，才能确认订单所需供给。</small>}{plan.warehouseRetrieveCandidates?.slice(0, 3).map((candidate: any) => <small key={`retrieve:${candidate.warehouseSlotId}:${candidate.orderSlot}`}>从仓库槽位 {candidate.warehouseSlotId} 取回 {candidate.itemId} · {localizedDetail(candidate.bufferPolicy)}</small>)}{plan.warehouseStoreCandidates?.slice(0, 3).map((candidate: any) => <small key={`store:${candidate.sourceIndex}`}>存入棋盘格 {candidate.sourceIndex} · {candidate.itemId} · 机会成本 {Number(candidate.opportunityCost).toFixed(2)} · {codeLabel(candidate.storeAvailability.status)}</small>)}</div>}
    {plan.saleSuggestions?.length > 0 && <div className="warehouse-planning"><strong>安全出售建议 · 自动出售已关闭</strong>{plan.saleSuggestions.slice(0,3).map((sale:any)=><span key={`${sale.sourceIndex}:${sale.itemId}`}>{sale.itemId} · 棋盘格 {sale.sourceIndex} · +{sale.expectedCoins} 金币 · {localizedDetail(sale.reason)} · 机会价值 {Number(sale.opportunityValue).toFixed(2)}{mode === "assisted" ? <button className="inline-priority" onClick={()=>onSell?.(sale)}>确认出售</button> : <small>{mode === "observation" ? "仅提供建议" : "自动执行已关闭"}</small>}</span>)}</div>}
    {state.orders?.length ? state.orders.map((order: any) => {
      const p = plans.find((candidate: any) => String(candidate.slot) === String(order.slot));
      const complete = order.requiredItemIds?.length ? Math.round((order.requiredItemIds.length - order.missingItemIds.length) / order.requiredItemIds.length * 100) : order.ready ? 100 : 0;
      return <article className={`order-card ${plan.recommended?.slot === order.slot ? "recommended" : ""} ${p?.evidenceBlock ? "evidence-blocked" : ""}`} key={order.slot}>
        <div className="avatar">{String(order.slot).match(/\d/)?.[0] || "订"}</div><div className="order-main"><div className="order-title"><strong>订单 {order.slot}</strong>{plan.recommended?.slot === order.slot && <em>推荐</em>}<span><CircleDollarSign size={15}/>{order.rewardCoins}</span></div><div className="mini-progress"><i style={{ width: `${complete}%` }}/></div><div className="order-meta"><span>完成度 {complete}%</span><span>预计体力 {p?.estimatedEnergy ?? "--"}</span><span>效率 {Number(p?.efficiency || 0).toFixed(2)}</span><span>缺少 {order.missingItemIds?.length || 0}</span><button className="inline-priority" onClick={() => onPrioritize?.(order.slot)}>设为优先</button></div>
        {p?.boardSpaceFeasibility && <div className={`space-plan ${p.boardSpaceFeasibility.feasible ? "feasible" : "blocked"}`}><strong>{p.nextAction ? `下一步：${actionLabel(p.nextAction.type)}${p.nextAction.type === "merge" ? ` ${p.nextAction.from} → ${p.nextAction.to}` : p.nextAction.type === "switch-production-mode" ? ` · 棋盘格 ${p.nextAction.producer} · ${codeLabel(p.nextAction.currentModeId)} → ${p.nextAction.productionModeId}` : p.nextAction.producer != null ? ` · 棋盘格 ${p.nextAction.producer}${p.nextAction.productionModeId ? ` · 档位 ${p.nextAction.productionModeId}` : ""}` : ""}` : `等待：${localizedDetail(p.blockingReason || "no deterministic action")}`}</strong><span>棋盘空间：{p.boardSpaceFeasibility.feasible ? "可行" : "受阻"} · 峰值占用 {p.boardSpaceFeasibility.peakOccupied}/{p.boardSpaceFeasibility.capacity} · 最小缓冲 {p.boardSpaceFeasibility.minimumEmpty}</span>{p.nextAction?.decision?.metrics && <small>档位评分：体力 {p.nextAction.decision.metrics.energy} · 峰值 {p.nextAction.decision.metrics.peakOccupied} · 合成 {p.nextAction.decision.metrics.mergeCount} · 超额 {p.nextAction.decision.metrics.overshootUnits}</small>}{p.explanation?.selected && <small>{localizedDetail(p.explanation.selected)}</small>}{p.explanation?.riskBranches?.length > 0 && <small>风险分支：{p.explanation.riskBranches.slice(0,6).map((branch:any)=>`${localizedDetail(branch.kind)} ${(Number(branch.probability)*100).toFixed(1)}% ${branch.safe ? "安全" : localizedDetail(branch.reason)}`).join(" · ")}</small>}{p.explanation?.pruned && Object.keys(p.explanation.pruned).length > 0 && <small>已剪枝：{Object.entries(p.explanation.pruned).map(([reason, count]) => `${localizedDetail(reason)}（${count}）`).join("，")}</small>}</div>}
        {p?.evidenceBlock && <div className="order-evidence-block"><strong>图鉴证据阻塞</strong>{p.evidenceBlock.blockers.map((blocker: any) => <div key={`${blocker.objectType}:${blocker.objectId}`}><span>{localizedDetail(blocker.objectType)}：{blocker.objectId} / {codeLabel(blocker.status)} / 字段 {blocker.fields.join("、")} / 需要 {blocker.requiredEvidence.map(localizedDetail).join(" 或 ")}</span><button onClick={() => onReviewEvidence?.(blocker.reviewTarget)}>审核</button><button onClick={() => onScanEvidence?.([blocker.scanAction.itemId])}>扫描</button></div>)}</div>}
        </div>
      </article>;
    }) : <div className="empty-state"><ClipboardList size={34}/><strong>正在等待订单</strong><span>打开棋盘并刷新，即可读取实时订单。</span></div>}
  </div>;
}

function parseJson(value: any) { try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; } }
function actionDiffText(row: any) {
  const details = parseJson(row.details_json) || row.action || {};
  const diff = details.diff || details;
  if (diff.type === "produce" && diff.emptyBefore != null) return `棋盘空位 ${diff.emptyBefore} → ${diff.emptyAfter}`;
  if (diff.type === "merge") return `${diff.itemId || "物品"}：格 ${diff.from} → ${diff.to}${diff.actualTarget ? `，生成 ${diff.actualTarget}` : ""}`;
  if (details.coinsBefore != null) return `金币 ${details.coinsBefore} → ${details.coinsAfter}`;
  const before = parseJson(row.before_json), after = parseJson(row.after_json);
  if (before?.resources && after?.resources) return `金币 ${before.resources.coins} → ${after.resources.coins}；体力 ${before.resources.energy} → ${after.resources.energy}`;
  return details.reason || row.reason || "--";
}

async function waitForCatalogIconTask(taskId: number) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const task = await controlApi.getCatalogIconTask(taskId);
    if (["complete", "error"].includes(task?.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { status: "error", error: "icon-task-timeout" };
}

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [data, setData] = useState<any>(demo);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("正在等待 CDP 连接");
  const [autoMap, setAutoMap] = useState(false);
  const [events, setEvents] = useState<any[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState({ mode: "observation", delayMs: 100, settleMs: 500, autoMapUpgrade: false, strategy: "efficiency", prioritySlot: null as string | null, fontScale: 1.1 });
  const [selectedGrid, setSelectedGrid] = useState<any>(null);
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  const [reviewFocus, setReviewFocus] = useState<{ objectType: string; objectId: string } | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [connectionRoute, setConnectionRoute] = useState<any>({ listening: false, managed: false });
  const catalogImportRef = useRef<HTMLInputElement>(null);

  const reloadCatalog = async () => {
    const catalogView = await controlApi.getCatalog();
    if (catalogView) setData((old: any) => ({ ...old, catalog: catalogView.stats || old.catalog, catalogView }));
  };

  const refresh = async () => { setLoading(true); try { const next = await controlApi.getDashboard(); if (next) { setData((old:any) => ({ ...next, catalogView: { ...next.catalogView, repository: { ...old.catalogView?.repository, ...next.catalogView?.repository } } })); setConnectionRoute(next.connectionRoute || connectionRoute); setMessage(next.connected ? "运行时状态已同步" : next.connectionRoute?.starting ? "正在自动启动 CDP…" : next.connectionRoute?.listening ? "CDP 已就绪，正在等待目标游戏…" : "正在准备 CDP 连接…"); } } catch (e: any) { setData((x: any) => ({ ...x, connected: false })); setMessage("仪表盘暂时不可用，正在重试连接"); } finally { setLoading(false); } };
  useEffect(() => {
    const requestedScale = Number(settings.fontScale) || 1;
    document.documentElement.style.zoom = String(Math.min(1.1, Math.max(1, requestedScale)));
  }, [settings.fontScale]);
  useEffect(() => { refresh(); reloadCatalog(); controlApi.getConnectionStatus().then((value) => value && setConnectionRoute(value)); controlApi.getSettings().then((value) => { if (value) { setSettings(value); setAutoMap(!!value.autoMapUpgrade); } }); const off = controlApi.onEvent((event) => { setEvents((old) => [event, ...old].slice(0, 100)); if (event.type === "automation-status") { setData((old: any) => ({ ...old, running: event.running, paused: !!event.paused })); if (event.message) setMessage(event.message); } if (event.type === "settings-updated" && event.settings) { setSettings(event.settings); setAutoMap(!!event.settings.autoMapUpgrade); } if (event.type === "automation-complete") setMessage(`自动化停止：${localizedDetail(event.result?.reason || "已完成")}`); if (event.type === "automation-error") setMessage(`自动化异常：${localizedDetail(event.error)}`); if (event.type === "icon-acquisition-complete") setMessage(event.cached ? "已使用缓存图标" : event.provider === "screenshot-runtime" ? "精确资源映射失败，已采集稳定截图候选" : "精确运行时图标已采集"); if (event.type === "active-catalog-scan-complete") setMessage(event.ok ? "主动图鉴扫描已完成，图鉴状态与计划均已重新评估。" : `主动图鉴扫描已停止：${localizedDetail(event.reason)}`); if (event.type === "icon-acquisition-error") setMessage(`图标采集失败：${localizedDetail(event.error)}`); if (["catalog-state-updated", "catalog-review-updated", "catalog-repository-imported", "icon-acquisition-complete", "active-catalog-scan-complete"].includes(event.type)) { reloadCatalog(); refresh(); } if (event.type === "catalog-passive-evidence") reloadCatalog(); if (event.type === "connection-route") controlApi.getConnectionStatus().then((value) => value && setConnectionRoute(value)); }); const timer = setInterval(() => { refresh(); controlApi.getConnectionStatus().then((value) => value && setConnectionRoute(value)); }, 8000); return () => { off?.(); clearInterval(timer); }; }, []);
  const run = async (maxActions?: number) => {
    setData((old: any) => ({ ...old, running: true, paused: false }));
    setMessage("正在启动自动化并生成首个计划…");
    try {
      const result = await controlApi.start({ ...settings, ...(maxActions ? { maxActions } : {}), autoMapUpgrade: autoMap });
      if (!result?.accepted && result?.reason !== "already-running") setData((old: any) => ({ ...old, running: false, paused: false }));
      setMessage(result?.accepted ? "自动化已启动" : result?.reason === "already-running" ? "自动化已在运行" : `启动结果：${localizedDetail(result?.reason || "unknown")}`);
      await refresh();
    } catch (error: any) {
      setData((old: any) => ({ ...old, running: false, paused: false }));
      setMessage(`自动化启动失败：${localizedDetail(error.message)}`);
    }
  };
  const observeNow = async () => { setMessage("正在计算下一步建议…"); const result = await controlApi.preview({ ...settings, autoMapUpgrade: autoMap }); setMessage(`观察结果：${localizedDetail(result?.reason || "计划已生成")}`); await refresh(); };
  const toggleRun = async () => { if (data.running) { if (data.paused) { await controlApi.resume(); setMessage("自动化已继续"); } else { await controlApi.pause(); setMessage("自动化将在当前原子动作后暂停"); } return; } if (settings.mode === "observation") return observeNow(); if (settings.mode === "assisted") return run(1); return run(); };
  const startIdle = async () => { if (!window.confirm("启动挂机自动化会等待体力实时恢复，并持续运行到手动停止。确认启动？")) return; setData((old: any) => ({ ...old, running: true, paused: false })); try { const result = await controlApi.startIdle({ ...settings, mode: settings.mode === "observation" ? "assisted" : settings.mode, autoMapUpgrade: autoMap }); if (!result?.accepted && result?.reason !== "already-running") setData((old: any) => ({ ...old, running: false, paused: false })); setMessage(result?.accepted ? "挂机自动化已启动" : `挂机启动结果：${localizedDetail(result?.reason || "unknown")}`); await refresh(); } catch (error: any) { setData((old: any) => ({ ...old, running: false, paused: false })); setMessage(`挂机自动化启动失败：${localizedDetail(error.message)}`); } };
  const stopRun = async () => { await controlApi.stop(); setMessage("正在安全停止自动化…"); };
  const singleStep = () => { if (!data.running) run(1).catch((e) => setMessage(e.message)); };
  const saveSettings = async () => { const saved = await controlApi.saveSettings({ ...settings, autoMapUpgrade: autoMap }); if (saved) setSettings(saved); setSettingsOpen(false); setMessage("偏好设置已保存"); };
  const changeStrategy = async (strategy: string) => { const next = { ...settings, strategy, prioritySlot: strategy === "specified" ? settings.prioritySlot : null }; setSettings(next); const saved = await controlApi.saveSettings({ ...next, autoMapUpgrade: autoMap }); if (saved) setSettings(saved); await refresh(); };
  const prioritizeOrder = async (slot: string) => { const next = { ...settings, strategy: "specified", prioritySlot: String(slot) }; setSettings(next); const saved = await controlApi.saveSettings({ ...next, autoMapUpgrade: autoMap }); if (saved) setSettings(saved); setMessage(`已优先订单 ${slot}`); await refresh(); };
  const reviewEvidence = (target: { objectType: string; objectId: string }) => { setReviewFocus(target); setTab("catalog"); };
  const scanEvidence = async (itemIds: string[]) => { setLoading(true); setMessage("正在执行受控的主动图鉴扫描…"); try { const result = await controlApi.runActiveCatalogScan([...new Set(itemIds.map(String))]); setMessage(result.ok ? "主动图鉴扫描已完成，计划已重新评估。" : `主动图鉴扫描已停止：${localizedDetail(result.reason)}`); await reloadCatalog(); await refresh(); } catch (error: any) { setMessage(localizedDetail(error.payload?.reason || error.message)); } finally { setLoading(false); } };
  const exportDiagnostic = async () => { setMessage("正在导出诊断包…"); const result = await controlApi.exportDiagnostic(); setMessage(result?.ok ? `诊断包已下载：${result.fileName}` : "诊断包导出失败"); };
  const toggleConnectionRoute = async () => { setLoading(true); try { const result = connectionRoute.managed ? await controlApi.stopConnection() : await controlApi.startConnection(); setConnectionRoute(result); setMessage(result?.ok ? (result.reason === "route-stopped" ? "CDP 路线已停止" : "CDP 路线已就绪") : `连接启动失败：${result?.reason}`); if (result?.ok && result.reason !== "route-stopped") await refresh(); } catch (error: any) { setMessage(error.message); } finally { setLoading(false); } };
  const rescanCatalog = async () => { setLoading(true); setMessage("正在读取当前选中物品的状态栏…"); try { const result = await controlApi.refreshCatalog(); if (result?.ok) { setData((old: any) => ({ ...old, catalog: result.catalogView.stats, catalogView: result.catalogView })); setMessage(`图鉴已更新：${result.captureFile}`); } else if (result?.reason === "catalog-scan-selection-required") setMessage("请先在游戏棋盘中选中一个普通合成物品，确认详情状态栏已经显示，再重新扫描。"); else if (result?.reason === "selected-item-chain-data-not-found") setMessage("已检测到选中物品，但当前详情状态栏没有可识别的合成链数据；请换一个普通合成物品后重试。"); else setMessage(`图鉴扫描停止：${localizedDetail(result?.reason)}`); } catch (error: any) { setMessage(error.message); } finally { setLoading(false); } };
  const exportCatalog = async () => { setLoading(true); try { const result = await controlApi.exportCatalog(); setMessage(`SQLite 图鉴已导出：${result.fileName}`); } catch (error: any) { setMessage(error.message); } finally { setLoading(false); } };
  const importCatalog = async (file?: File) => { if (!file) return; setLoading(true); try { const result = await controlApi.importCatalog(JSON.parse(await file.text())); await reloadCatalog(); setMessage(`图鉴导入完成：新增 ${result.imported}，保留现有 ${result.preserved}`); } catch (error: any) { setMessage(`图鉴导入失败：${error.message}`); } finally { if (catalogImportRef.current) catalogImportRef.current.value = ""; setLoading(false); } };
  const executeSale = async (sale: any) => { if (!window.confirm(`从棋盘格 ${sale.sourceIndex} 出售 ${sale.itemId}，获得 ${sale.expectedCoins} 金币？`)) return; setLoading(true); try { const result = await controlApi.executeSale(sale); setMessage(result?.ok ? "出售结果已验证" : `出售已停止：${localizedDetail(result?.reason || "unknown")}`); await refresh(); } catch (error: any) { setMessage(localizedDetail(error.message)); } finally { setLoading(false); } };
  const completeMap = async () => { if (!window.confirm("完成地图任务会消耗金币，确认继续？")) { setMessage("已取消地图升级"); return; } setLoading(true); setMessage("正在完成地图任务…"); try { const result = await controlApi.completeMapMission(); setMessage(result?.ok ? "地图任务升级完成" : `地图升级停止：${result?.reason}`); await refresh(); } catch (e: any) { setMessage(e.message); } finally { setLoading(false); } };
  const mapMission = data.state.mapMission;
  const currentMapTaskId = data.state.mapProgress?.currentTask || mapMission?.progressTaskId || mapMission?.id;
  const mapConfigurationStale = Boolean(mapMission?.configurationStale || (mapMission?.id && currentMapTaskId && String(mapMission.id) !== String(currentMapTaskId)));
  const requirement = mapConfigurationStale ? null : mapMission?.requirements?.[0];
  const energy = data.state.resources.energy || 0;
  const actionRows = useMemo(() => [...events, ...(data.actions || []).map((x: any) => ({ ...x, type: x.action_type, at: x.created_at, action: parseJson(x.details_json) || { reason: x.reason }, ok: x.ok }))].slice(0, 80), [events, data.actions]);
  const catalogItems = data.catalogView?.items || [];
  const boardCatalogItems = useMemo(() => {
    const byId = new globalThis.Map(catalogItems.map((item: any) => [String(item.id), { ...item }]));
    for (const [itemId, iconUrl] of Object.entries(data.catalogView?.iconUrls || {})) {
      const item: any = byId.get(String(itemId));
      byId.set(String(itemId), item ? { ...item, iconUrl: item.iconUrl || iconUrl } : { id: String(itemId), iconUrl, displayOnly: true });
    }
    return [...byId.values()];
  }, [catalogItems, data.catalogView?.iconUrls]);
  const selectedCatalogItem: any = selectedGrid?.itemId ? boardCatalogItems.find((item: any) => String(item.id) === String(selectedGrid.itemId)) : null;
  const selectedChain = (data.catalogView?.chains || []).find((chain: any) => String(chain.id) === String(selectedChainId || selectedCatalogItem?.chainId));
  const selectedChainItems = selectedChain ? catalogItems.filter((item: any) => String(item.chainId) === String(selectedChain.id)).sort((a: any,b: any) => Number(a.level)-Number(b.level)) : [];
  const acquireSelectedChainIcons = async () => {
    const pendingItems = selectedChainItems;
    if (!pendingItems.length) return;
    setLoading(true);
    setMessage(`正在从已加载的运行时纹理采集整链图标：0/${pendingItems.length}`);
    try {
      const queued = [];
      for (let index = 0; index < pendingItems.length; index += 1) {
        queued.push(await controlApi.acquireCatalogIcon(String(pendingItems[index].id)));
        setMessage(`正在从已加载的运行时纹理采集整链图标：已入队 ${index + 1}/${pendingItems.length}`);
      }
      const results = await Promise.all(queued.map((task: any) => waitForCatalogIconTask(Number(task.taskId))));
      const complete = results.filter((task: any) => task.status === "complete").length;
      const pending = results.length - complete;
      await reloadCatalog();
      setMessage(pending ? `整链图标采集完成：成功 ${complete}，待补采 ${pending}（资源尚未加载或无法精确匹配）。` : `整链图标采集完成：成功 ${complete}/${results.length}，未产生棋盘动作。`);
    } catch (error: any) {
      await reloadCatalog();
      setMessage(`整链图标采集停止：${localizedDetail(error.message)}`);
    } finally { setLoading(false); }
  };
  const catalogStates = data.catalogView?.repository?.summary?.states || { observed: 0, provisional: 0, active: 0 };
  const coinSamples = data.resourceSamples || [];
  const coinDelta = coinSamples.length > 1 ? Number(coinSamples.at(-1).coins) - Number(coinSamples[0].coins) : 0;
  const feasibleRewards = (data.plan.plans || []).filter((plan: any) => plan.feasible && Number(plan.rewardCoins) > 0).map((plan: any) => Number(plan.rewardCoins));
  const averageOrderReward = feasibleRewards.length ? feasibleRewards.reduce((sum: number, value: number) => sum + value, 0) / feasibleRewards.length : 0;
  const estimatedOrdersForMap = requirement && averageOrderReward > 0 ? Math.ceil(Number(requirement.deficit || 0) / averageOrderReward) : null;
  const recommendedPlan = data.plan.recommended;
  const evidenceReviewTarget = (data.plan.evidenceBlocks || [])
    .flatMap((block: any) => block.blockers || [])
    .map((blocker: any) => blocker.reviewTarget)
    .find((target: any) => target?.objectType && target?.objectId) || null;
  const nextActionLabel = data.state.mapMission?.canComplete
    ? "完成地图升级"
    : recommendedPlan
      ? `推进订单 ${recommendedPlan.slot}`
      : data.connected
        ? "读取棋盘并生成计划"
        : "连接目标游戏";
  const nextActionReason = localizedDetail(recommendedPlan?.explanation?.selected
    || (recommendedPlan ? "当前方案在体力、空间和订单收益之间最均衡。" : data.connected ? "获取最新棋盘快照后才能形成可执行计划。" : "CDP 目标连接成功后会自动读取实时状态。"));
  const riskCount = Number(!data.connected) + Number(energy <= 10) + Number((data.state.board.empty || 0) <= 3) + Number(data.plan.status === "evidence-waiting");

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><Sparkles/></div><div><strong>合成小管家</strong><span>合成自动化控制台</span></div></div>
      <nav>{tabs.map(({ id, label, icon: Icon }) => <button className={tab === id ? "active" : ""} onClick={() => setTab(id)} key={id}><Icon size={19}/><span>{label}</span>{id === "orders" && data.state.orders?.length > 0 && <b>{data.state.orders.length}</b>}</button>)}</nav>
      <div className="sidebar-bottom"><div className={`connection-pill ${data.connected ? "online" : connectionRoute.listening ? "ready" : ""}`} title={connectionRoute.logPath || ""}><i/>{data.connected ? "目标游戏已连接" : connectionRoute.listening ? "CDP 已就绪" : "CDP 未启动"}</div><button className="route-button" onClick={toggleConnectionRoute} disabled={loading || (connectionRoute.listening && !connectionRoute.managed)}>{connectionRoute.managed ? "停止受管CDP" : connectionRoute.listening ? "检测到外部CDP" : "启动 WMPF / CDP"}</button><button onClick={() => setSettingsOpen(true)}><Settings size={18}/>偏好设置</button></div>
    </aside>
    <main><header className="command-bar">
      <div className="command-connection"><span>CDP 连接</span><strong className={data.connected ? "online" : connectionRoute.listening ? "ready" : "offline"}><i/>{data.connected ? "已连接" : connectionRoute.listening ? "已就绪" : "未启动"}</strong><small>{message}</small></div>
      <div className="command-mode"><span>运行模式</span><div className="mode-switch">{[["observation","观察"],["assisted","辅助"],["automatic","自动"]].map(([id,label]) => <button key={id} className={settings.mode === id ? "active" : ""} onClick={() => setSettings((old) => ({ ...old, mode: id }))} disabled={data.running}>{label}</button>)}</div></div>
      <div className="header-actions"><button className="icon-btn" onClick={refresh} disabled={loading} aria-label="刷新状态"><RefreshCw className={loading ? "spin" : ""}/></button><button className="ghost-btn step-btn" onClick={singleStep} disabled={data.running}><StepForward size={17}/>单步执行</button><button className={`run-btn ${data.running && !data.paused ? "stop" : ""}`} onClick={toggleRun}>{data.running ? data.paused ? <Play fill="currentColor"/> : <Pause/> : settings.mode === "observation" ? <RefreshCw/> : <Play fill="currentColor"/>}{data.running ? data.paused ? "继续自动化" : "暂停自动化" : settings.mode === "observation" ? "生成建议" : settings.mode === "assisted" ? "确认单步" : "开始自动化"}</button><button className="ghost-btn stop-btn" onClick={stopRun} disabled={!data.running}><Square size={14}/>停止</button></div>
    </header>
      <div className="content">
        {tab !== "overview" && <div className="page-title-row"><div><span>自动化工作台 / {tabs.find(x => x.id === tab)?.label}</span><h1>{tabs.find(x => x.id === tab)?.label}</h1></div><small>实时数据 · 操作后自动重新规划</small></div>}
        {tab === "overview" && <>
          <section className="tactical-overview">
            <article className="panel situation-panel"><div className="panel-head"><div><span className="eyebrow">战场态势</span><h2>当前棋盘 {data.state.board.width || 7} × {data.state.board.height || 9}</h2></div><button className="panel-link" onClick={() => setTab("board")}>打开完整棋盘 <Route size={15}/></button></div><div className="situation-grid"><div className="tactical-board-shell"><Board state={data.state} catalogItems={boardCatalogItems} selectedIndex={selectedGrid?.index} onSelect={(grid: any) => { setSelectedGrid(grid); setTab("board"); }} onImageClick={setLightboxSrc}/></div><aside className="board-brief"><span className="eyebrow">为什么这样做？</span><h3>{nextActionLabel}</h3><p>{nextActionReason}</p><dl><div><dt>安全合成</dt><dd>{data.state.board.mergeCandidates?.length || 0} 组</dd></div><div><dt>可用产出物</dt><dd>{data.state.producers?.length || 0} 个</dd></div><div><dt>预期收益</dt><dd>{recommendedPlan?.rewardCoins ?? 0} 金币</dd></div></dl></aside></div></article>
            <aside className="tactical-side">
              <section className="panel next-action-panel"><div className="step-track"><i className="active">1</i><b/><i>2</i><b/><i>3</i></div><span className="eyebrow">下一步行动</span><h2>{nextActionLabel}</h2><p>{recommendedPlan ? `预计消耗 ${recommendedPlan.estimatedEnergy ?? "--"} 体力 · 效率 ${Number(recommendedPlan.efficiency || 0).toFixed(1)}` : "先同步实时状态，再形成安全的原子动作。"}</p><button className={`execute-next ${data.running && !data.paused ? "stop" : ""}`} onClick={toggleRun}>{data.running ? data.paused ? <Play size={18} fill="currentColor"/> : <Pause size={18}/> : <Play size={18} fill="currentColor"/>}{data.running ? data.paused ? "继续自动化" : "暂停自动化" : settings.mode === "observation" ? "生成下一步建议" : settings.mode === "assisted" ? "执行下一步" : "开始自动执行"}</button></section>
              <section className="panel risk-panel"><div className="panel-head"><div><span className="eyebrow">阻塞与风险</span><h2>{riskCount ? `${riskCount} 项需要关注` : "运行边界正常"}</h2></div><AlertTriangle size={19}/></div>{!data.connected && <div className="risk-row critical"><AlertTriangle/><div><strong>目标未连接</strong><span>启动连接路线并打开目标游戏。</span></div><button onClick={toggleConnectionRoute}>处理</button></div>}{energy <= 10 && <div className="risk-row warning"><Zap/><div><strong>体力不足</strong><span>当前 {energy}/{data.state.energy.limit || 100}，建议等待恢复。</span></div></div>}{(data.state.board.empty || 0) <= 3 && <div className="risk-row warning"><Boxes/><div><strong>棋盘空间紧张</strong><span>只剩 {data.state.board.empty || 0} 个空格。</span></div></div>}{data.plan.status === "evidence-waiting" && <div className="risk-row warning"><Database/><div><strong>图鉴证据不足</strong><span>订单规划正在等待可用证据。</span></div><button onClick={() => evidenceReviewTarget ? reviewEvidence(evidenceReviewTarget) : setTab("catalog")}>审核</button></div>}{riskCount === 0 && <div className="risk-row safe"><Activity/><div><strong>暂无阻塞项</strong><span>当前状态允许继续执行计划。</span></div></div>}</section>
              <section className="panel progress-panel"><div className="panel-head"><div><span className="eyebrow">订单 / 地图进度</span><h2>当前推进目标</h2></div><Map size={17}/></div><div className="goal-split"><div><span>当前订单</span><strong>{data.state.orders?.length ? `${data.state.orders.length} 个待处理` : "等待订单"}</strong></div><div><span>地图任务</span><strong>{currentMapTaskId || "等待任务"}</strong></div></div><div className="mission-progress"><i style={{ width: `${requirement ? Math.min(100, requirement.current / Math.max(1, requirement.required) * 100) : 0}%` }}/></div><p><b>{requirement?.current || 0}</b> / {requirement?.required || 0} 金币{estimatedOrdersForMap != null ? ` · 约 ${estimatedOrdersForMap} 个订单` : ""}</p></section>
            </aside>
          </section>
          <section className="resource-tape"><div><CircleDollarSign/><span>金币</span><strong>{data.state.resources.coins}</strong></div><div><Zap/><span>体力</span><strong>{energy}<small>/{data.state.energy.limit || 100}</small></strong></div><div><Diamond/><span>钻石</span><strong>{data.state.resources.diamonds}</strong></div><div><Boxes/><span>空闲格子</span><strong>{data.state.board.empty}</strong></div><div><Activity/><span>运行状态</span><strong>{data.running ? data.paused ? "已暂停" : "执行中" : "待命"}</strong></div><div><Gauge/><span>最近采样</span><strong>{coinSamples.length}</strong></div></section>
        </>}
        {tab === "board" && <section className="split-page"><div className="panel board-panel"><div className="panel-head"><div><span className="eyebrow">实时棋盘</span><h2>{data.state.board.width || 7} × {data.state.board.height || 9} 合成区域</h2></div><span className="strategy-badge">空位 {data.state.board.empty}</span></div><Board state={data.state} catalogItems={boardCatalogItems} selectedIndex={selectedGrid?.index} onSelect={setSelectedGrid} onImageClick={setLightboxSrc}/></div><div className="side-stack"><div className="panel stat-list"><h3>棋盘分析</h3><div><span>已占用</span><strong>{data.state.board.occupied}</strong></div><div><span>安全合成</span><strong>{data.state.board.mergeCandidates?.length || 0}</strong></div><div><span>订单保留物</span><strong>{Object.values(data.state.board.requiredItemCounts || {}).reduce((a: number,b: any)=>a+Number(b),0)}</strong></div><div><span>产出物</span><strong>{data.state.producers?.length || 0}</strong></div></div><div className="panel item-inspector"><h3>格子详情</h3>{selectedGrid ? <><div className={`detail-gem ${selectedCatalogItem?.iconUrl ? "has-icon" : ""}`}>{selectedCatalogItem?.iconUrl ? <img src={selectedCatalogItem.iconUrl} alt="" onClick={() => setLightboxSrc(selectedCatalogItem.iconUrl)}/> : <Sparkles/>}<div><strong>{selectedGrid.itemId || "空格"}</strong><span>格子 {selectedGrid.index} · 等级 {selectedCatalogItem?.level || selectedGrid.level || "未知"}</span></div></div>{selectedCatalogItem?.chainId ? <><p>合成链 {selectedCatalogItem.chainId}</p><p>下一等级 {selectedCatalogItem.mergeTarget || "最高已知等级"}</p><p>{selectedCatalogItem.iconUrl ? "已取得图标证据" : "图标待采集（不影响规划）"}</p><button className="ghost-btn" onClick={() => { setSelectedChainId(String(selectedCatalogItem.chainId)); setTab("catalog"); }}>查看完整合成链</button></> : selectedCatalogItem?.iconUrl ? <p>真实图标已取得，合成链结构仍待补充。</p> : <p>该物品尚无图鉴记录</p>}</> : <div className="empty-state compact"><Boxes/><span>点击棋盘格查看物品ID、等级与合成链</span></div>}</div></div></section>}
        {tab === "orders" && <section className="split-page"><div className="panel grow"><div className="panel-head"><div><span className="eyebrow">滚动规划</span><h2>当前订单队列</h2></div><select className="strategy-select" value={settings.strategy} onChange={(event) => changeStrategy(event.target.value)}><option value="efficiency">最高金币/体力</option><option value="min-energy">最少体力</option><option value="fastest">最快完成订单</option><option value="specified" disabled={!settings.prioritySlot}>指定订单优先</option></select></div><Orders state={data.state} plan={data.plan} mode={settings.mode} onSell={executeSale} onPrioritize={prioritizeOrder} onReviewEvidence={reviewEvidence} onScanEvidence={scanEvidence}/></div><div className="panel order-summary"><h3>本轮摘要</h3>{settings.prioritySlot && <p className="priority-note">手动优先：{settings.prioritySlot}</p>}<div className="summary-number"><strong>{data.plan.recommended?.estimatedEnergy ?? "--"}</strong><span>预计体力</span></div><div className="summary-number"><strong>{data.plan.recommended?.rewardCoins ?? "--"}</strong><span>预计金币</span></div><p>每次产出或合成后都会重新读取棋盘，避免随机产出导致旧计划失效。</p></div></section>}
        {tab === "catalog" && <section className="catalog-page"><div className="catalog-toolbar"><div><span className="eyebrow">状态栏采集</span><p>在游戏中选中一个物品后，可把它的完整合成链增量写入本地图鉴。</p></div><div className="catalog-toolbar-actions"><button className="ghost-btn" onClick={exportCatalog} disabled={loading}><Download size={15}/>导出数据库图鉴</button><button className="ghost-btn" onClick={()=>catalogImportRef.current?.click()} disabled={loading}><Upload size={15}/>导入 JSON</button><input ref={catalogImportRef} type="file" accept="application/json,.json" hidden onChange={(event)=>importCatalog(event.target.files?.[0])}/><button className="ghost-btn" onClick={rescanCatalog} disabled={loading}><RefreshCw size={15}/>重新扫描当前状态栏</button></div></div><div className="catalog-state-strip" aria-label="图鉴证据状态">{[["已观察",catalogStates.observed],["暂定",catalogStates.provisional],["生效",catalogStates.active]].map(([label,value]:any)=><div className={`catalog-state ${label === "已观察" ? "observed" : label === "暂定" ? "provisional" : "active"}`} key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>{(data.catalogView?.repository?.productionDistributionReviews?.length || 0) > 0 && <div className="priority-note">产出概率冲突待审核：{data.catalogView.repository.productionDistributionReviews.length}</div>}<CatalogReviewWorkspace repository={data.catalogView?.repository} onChanged={reloadCatalog} focusObject={reviewFocus}/><div className="catalog-grid compact-grid">{[["合成链",data.catalog.chains,"条",Route],["已识别物品",data.catalog.items,"件",Sparkles],["产出物配置",data.catalog.producers,"组",Boxes],["概率样本",data.catalog.drops,"项",Activity]].map(([label,value,unit,Icon]:any)=><div className="panel catalog-card" key={label}><Icon/><span>{label}</span><strong>{value}<small>{unit}</small></strong><i/></div>)}</div><div className="catalog-detail-grid"><div className="panel chain-list"><div className="panel-head"><div><span className="eyebrow">真实图鉴数据</span><h2>合成链</h2></div></div>{(data.catalogView?.chains || []).map((chain:any)=><button key={chain.id} className={String(selectedChain?.id)===String(chain.id)?"active":""} onClick={()=>setSelectedChainId(String(chain.id))}><span>{chain.id}</span><em>L{chain.minLevel}–L{chain.maxLevel || chain.observedMaxLevel || "?"}</em><i className={chain.complete?"observed":"inferred"}>{chain.complete?"完整":"待补充"}</i></button>)}</div><div className="panel chain-view"><div className="panel-head"><div><span className="eyebrow">2 × n级 → 1 × n+1级</span><h2>{selectedChain?.id || "请选择合成链"}</h2></div>{selectedChainItems.length > 0 && <div className="review-head-actions"><button className="ghost-btn" disabled={loading} onClick={acquireSelectedChainIcons}><Sparkles size={15}/>采集整链图标</button></div>}</div>{selectedChainItems.length ? <div className="chain-flow">{selectedChainItems.map((item:any,index:number)=><div className="chain-node-wrap" key={item.id}><div className={`chain-node ${item.iconUrl ? "has-real-icon" : "missing-real-icon"}`}>{item.iconUrl ? <img src={item.iconUrl} alt="" onClick={() => setLightboxSrc(item.iconUrl)}/> : <Sparkles/>}<strong>L{item.level}</strong><span>{item.id}</span><small>{item.iconUrl ? "运行时图标" : "待采集"}</small></div>{index<selectedChainItems.length-1&&<b>×2 →</b>}</div>)}</div> : <div className="empty-state"><Route/><span>从左侧选择一条合成链</span></div>}<div className="producer-relations"><h3>对应产出物与概率</h3>{(data.catalogView?.producers || []).filter((producer:any)=>producer.drops?.some((drop:any)=>String(drop.chainId)===String(selectedChain?.id)) || producer.modes?.some((mode:any)=>mode.drops?.some((drop:any)=>String(drop.chainId)===String(selectedChain?.id)))).map((producer:any)=><article key={producer.itemId}><strong>{producer.itemId}</strong><span>体力 {producer.energyCost} · 样本 {producer.sampleSize || 0}</span>{producer.drops.filter((drop:any)=>String(drop.chainId)===String(selectedChain?.id)).map((drop:any)=><em className="drop-probability" key={drop.itemId}><span>&rarr; {drop.itemId} L{drop.level}</span><i><b style={{width:`${Math.max(2,Number(drop.probability)*100)}%`}}/></i><strong>{(Number(drop.probability)*100).toFixed(1)}%</strong></em>)}{(producer.modes || []).map((mode:any)=><div className="priority-note" key={mode.modeId}><strong>档位 {mode.modeId}</strong><span> · {localizedDetail(mode.planningDistribution?.basis || "待建立后验")} · 置信度 {codeLabel(mode.confidence?.level)} · 不确定质量 {mode.uncertaintyMass == null ? "--" : `${(Number(mode.uncertaintyMass)*100).toFixed(1)}%`}</span>{mode.drops?.map((drop:any)=><span key={drop.itemId}> · {drop.itemId} 期望 {(Number(drop.expectedProbability)*100).toFixed(1)}%{drop.uncertainty ? `（${(Number(drop.uncertainty.lower)*100).toFixed(1)}–${(Number(drop.uncertainty.upper)*100).toFixed(1)}%）` : ""}</span>)}</div>)}</article>)}</div></div></div></section>}
        {tab === "map" && <section className="map-page"><div className="map-hero panel"><div className="map-visual"><div className="hill h1"/><div className="hill h2"/><div className="path"/><div className="mission-pin"><Map/><i/></div></div><div className="map-info"><span className="eyebrow">当前地图任务</span><h2>{currentMapTaskId || "等待地图数据"}</h2><p>{mapConfigurationStale ? "任务已经推进，请打开游戏地图界面后刷新任务配置。" : "收集订单金币，完成地图建设并解锁下一片区域。"}</p><div className="mission-requirement"><CircleDollarSign/><div><span>建设资金</span><strong>{mapConfigurationStale ? "待刷新" : `${requirement?.current || 0} / ${requirement?.required || 0}`}</strong></div><em>{mapConfigurationStale ? "配置未同步" : requirement?.enough ? "已满足" : `还差 ${requirement?.deficit || 0}`}</em></div>{estimatedOrdersForMap != null && <p className="map-estimate">按当前可规划订单平均奖励，预计还需完成约 <b>{estimatedOrdersForMap}</b> 个订单。</p>}<button className="primary-action" onClick={completeMap} disabled={data.running || mapConfigurationStale || !requirement?.enough || loading}>{data.running ? "自动化执行中" : "完成地图升级"}</button></div></div></section>}
        {tab === "logs" && <section className="panel log-panel"><div className="panel-head"><div><span className="eyebrow">审计与回放</span><h2>自动化动作日志</h2></div><button className="ghost-btn" onClick={exportDiagnostic}><Download size={16}/>导出诊断包</button></div><div className="log-table"><div className="log-row head"><span>时间</span><span>动作</span><span>前后差异 / 原因</span><span>状态</span></div>{actionRows.length ? actionRows.map((row:any,i)=><div className="log-row" key={i}><span>{new Date(row.at).toLocaleTimeString()}</span><span>{actionLabel(row.type)}</span><span>{localizedDetail(actionDiffText(row))}</span><span className={row.ok === false || row.ok === 0 ? "bad" : "good"}>{row.ok === false || row.ok === 0 ? "异常" : "完成"}</span></div>) : <div className="empty-state"><ScrollText/><strong>暂无动作记录</strong><span>开始观察或自动化后，所有动作都会记录在这里</span></div>}</div></section>}
      </div>
    </main>
    {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    {settingsOpen && <div className="modal-backdrop" onMouseDown={() => setSettingsOpen(false)}><section className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head"><div><span className="eyebrow">运行参数</span><h2>偏好设置</h2></div><button className="icon-btn" onClick={() => setSettingsOpen(false)}><X/></button></div>
      <label><span>默认运行模式</span><select value={settings.mode} onChange={(event) => setSettings((old) => ({ ...old, mode: event.target.value }))}><option value="observation">观察模式（只规划）</option><option value="assisted">辅助模式（单步确认）</option><option value="automatic">自动模式（连续执行）</option></select></label>
      <label><span>订单规划策略</span><select value={settings.strategy} onChange={(event) => setSettings((old) => ({ ...old, strategy: event.target.value, prioritySlot: event.target.value === "specified" ? old.prioritySlot : null }))}><option value="efficiency">最高金币/体力</option><option value="min-energy">最少体力</option><option value="fastest">最快完成订单</option><option value="specified" disabled={!settings.prioritySlot}>指定订单优先</option></select><small>{settings.prioritySlot ? `当前指定订单：${settings.prioritySlot}` : "可以在订单页点击“优先此订单”。"}</small></label>
      <label><span>自动模式结束边界</span><div className="settings-boundary">完成一个订单 <b>或</b> 体力归零</div><small>不再限制动作步数；辅助模式仍固定执行 1 步。棋盘空间不足时仅存入非订单、非产出物。</small></label>
      <label><span>界面字体大小</span><select value={settings.fontScale} onChange={(event) => setSettings((old) => ({ ...old, fontScale: Number(event.target.value) }))}><option value="0.9">较小（90%）</option><option value="1">标准（100%）</option><option value="1.1">默认加大（110%）</option><option value="1.2">大（120%）</option><option value="1.3">特大（130%）</option><option value="1.4">超大（140%）</option></select><small>保存后全局生效，下次启动继续使用。</small></label>
      <label><span>动作间隔（毫秒）</span><input type="number" min="50" max="250" value={settings.delayMs} onChange={(event) => setSettings((old) => ({ ...old, delayMs: Number(event.target.value) }))}/></label>
      <label><span>状态同步等待（毫秒）</span><input type="number" min="300" max="1000" value={settings.settleMs} onChange={(event) => setSettings((old) => ({ ...old, settleMs: Number(event.target.value) }))}/></label>
      <div className="settings-warning">自动完成地图任务会消耗金币，默认保持关闭；开启后自动化会在金币满足时直接推进地图任务。</div>
      <div className="modal-actions"><button className="ghost-btn" onClick={() => setSettingsOpen(false)}>取消</button><button className="run-btn" onClick={saveSettings}>保存设置</button></div>
    </section></div>}
  </div>;
}
