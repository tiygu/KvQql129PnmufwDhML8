import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, History, Image, Pause, Play, RotateCcw, Save, Upload, X } from "lucide-react";
import { controlApi } from "./control-api";
import { ImageLightbox } from "./ImageLightbox";

const reviewReasonMetadata: Record<string, { label: string; explanation: string }> = {
  "new-observation": {
    label: "新观测",
    explanation: "系统刚观测到这个对象，但现有线索还没有形成稳定含义。请核对完整候选是否与游戏中看到的一致。",
  },
  "inference-change": {
    label: "推断变化",
    explanation: "系统整理出一份尚未生效的完整候选，它可能解除当前订单的图鉴阻塞。请核对对象身份与关系是否正确。",
  },
  "evidence-conflict": {
    label: "证据冲突",
    explanation: "系统发现不同来源对这个对象的含义说法不一致，相关订单的规划可能因此受阻。请核对下方候选快照是否与游戏中看到的一致。",
  },
  "icon-gap": {
    label: "图标缺口",
    explanation: "对象只缺少展示图标，不影响当前规划。请在方便时补充视觉线索。",
  },
  "human-ruling-conflict": {
    label: "裁决冲突",
    explanation: "新线索与上一次人工结论不一致，规划仍沿用人工确认值。请核对当前完整候选，确认是否需要更新结论。",
  },
  "planning-recovery-pending": {
    label: "规划尚未恢复",
    explanation: "审核结论已经保存，但订单规划尚未恢复。请保留当前诊断上下文并查看重新规划结果。",
  },
};

const valueLabels: Record<string, string> = {
  "item-identity": "物品身份",
  "merge-relation": "合成关系",
  "production-profile": "产出档案",
  "production-mode": "产出档位",
  observed: "已观察",
  provisional: "暂定",
  active: "生效",
  enabled: "已启用",
  paused: "已暂停",
  eligible: "可采用",
  accepted: "已接受",
  rejected: "已否决",
  confirm: "确认",
  modify: "修改",
  revoke: "撤销",
  runtime: "运行时",
  automatic: "自动",
  uploaded: "上传",
  screenshot: "截图",
  resource: "资源",
  selected: "已选择",
  unselected: "未选择",
};

function valueLabel(value: any) {
  const text = String(value ?? "未知");
  return valueLabels[text] || text;
}

const fieldLabels: Record<string, string> = {
  name: "名称",
  level: "等级",
  type: "类型",
  itemId: "物品编号",
  chainId: "合成链编号",
  mergeTarget: "合成目标",
  producerId: "产出物编号",
  energyCost: "体力消耗",
  probability: "概率",
  drops: "产出分布",
  iconUrl: "图标地址",
};

function fieldLabel(value: string) {
  return fieldLabels[value] || value;
}

function display(value: any) {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function catalogObjectTitle(detail: any, summary: any) {
  if (summary?.displayTitle) return summary.displayTitle;
  const value = detail?.effectiveValue || detail?.algorithmCandidate || {};
  const confirmedName = ["name", "displayName", "title", "description", "descriptionKey"]
    .map((field) => detail?.humanValues?.[field]?.value)
    .find((candidate) => String(candidate || "").trim());
  const candidateName = confirmedName || value.name || value.displayName || value.title || value.description || value.descriptionKey;
  if (String(candidateName || "").trim()) return confirmedName ? String(candidateName).trim() : `疑似“${String(candidateName).trim()}”`;
  const level = Number(value.level);
  return Number.isFinite(level) && level > 0 ? `未命名物品（第 ${level} 级）` : "未命名物品";
}

const domainFieldOrder: Record<string, string[]> = {
  "item-identity": ["name", "displayName", "descriptionKey", "level", "type", "iconResourceIdentifier", "saleValue"],
  "merge-relation": ["level", "mergeTarget", "requiredCount"],
  "production-profile": ["level", "energyCost", "theoreticalDistribution", "observedDistribution", "candidateOutputs", "productionModes"],
  "production-mode": ["energyCost", "outputs", "unlocked", "switchEntry"],
};

function domainFields(detail: any) {
  const available = new Set([
    ...Object.keys(detail?.candidateVersion?.payload || {}),
    ...Object.keys(detail?.algorithmCandidate || {}),
    ...Object.keys(detail?.effectiveValue || {}),
    ...Object.keys(detail?.humanValues || {}),
  ]);
  return (domainFieldOrder[detail?.objectType] || []).filter((field) => available.has(field));
}

function reviewBaselineSnapshot(detail: any) {
  const hasEvidenceConflict = (detail?.reviewReasons || []).some((reason: any) => reason.type === "evidence-conflict");
  if (detail?.candidateVersion) return detail?.activeVersion?.payload || {};
  if (hasEvidenceConflict) return detail?.effectiveValue || detail?.activeVersion?.payload || {};
  if (Object.keys(detail?.humanValues || {}).length) return detail?.effectiveValue || {};
  return {};
}

function reviewCandidateSnapshot(detail: any) {
  const hasEvidenceConflict = (detail?.reviewReasons || []).some((reason: any) => reason.type === "evidence-conflict");
  if (hasEvidenceConflict) {
    const baseline = reviewBaselineSnapshot(detail);
    const conflictingEvidence = (detail?.evidence || []).find((evidence: any) =>
      evidence.disposition === "eligible" && display(evidence.payload) !== display(baseline));
    if (conflictingEvidence?.payload) return conflictingEvidence.payload;
  }
  return detail?.candidateVersion?.payload || detail?.algorithmCandidate || {};
}

function meaningfulDifferences(detail: any, fields: string[]) {
  const candidate = reviewCandidateSnapshot(detail);
  const baseline = reviewBaselineSnapshot(detail);
  return fields.flatMap((field) => {
    const oldValue = baseline[field];
    const newValue = candidate[field];
    return display(oldValue ?? null) === display(newValue ?? null)
      ? []
      : [{ field, oldValue, newValue }];
  });
}

function humanReadableReason(detail: any) {
  const planningResult = detail?.reviewResolution?.planningResult;
  if (planningResult && planningResult.recovered !== true) return reviewReasonMetadata["planning-recovery-pending"].explanation;
  const reasons = detail?.reviewReasons || [];
  const priority = ["planning-recovery-pending", "evidence-conflict", "human-ruling-conflict", "inference-change", "new-observation"];
  const reason = priority.find((type) => reasons.some((entry: any) => entry.type === type));
  if (reason) return reviewReasonMetadata[reason].explanation;
  if (detail?.completenessGaps?.length) return reviewReasonMetadata["icon-gap"].explanation;
  return reviewReasonMetadata["new-observation"].explanation;
}

function parseObjectDraft(value: string) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("完整对象必须是 JSON 对象");
  return parsed;
}

function markIconSelected(value: any, candidateId: number) {
  const iconCandidates = (value?.iconCandidates || []).map((candidate: any) => ({
    ...candidate,
    selected: Number(candidate.id) === Number(candidateId),
    selectionOrigin: Number(candidate.id) === Number(candidateId) ? "manual" : null,
  }));
  return { ...value, iconCandidates, selectedIcon: iconCandidates.find((candidate: any) => candidate.selected) || value?.selectedIcon || null };
}

export function CatalogReviewWorkspace({ repository, onChanged, focusObject = null }: { repository: any; onChanged: (catalog?: any) => void | Promise<void>; focusObject?: { objectType: string; objectId: string } | null }) {
  const queue = repository?.reviewQueue || [];
  const laterQueue = repository?.laterQueue || [];
  const objects = repository?.objects || [];
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [objectDraft, setObjectDraft] = useState("{}");
  const [actor, setActor] = useState("本地操作者");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [latestAuditSummary, setLatestAuditSummary] = useState<any>(null);
  const iconUploadRef = useRef<HTMLInputElement>(null);
  const detailRequestId = useRef(0);
  const completionRequest = useRef<{ key: string; requestId: string } | null>(null);

  const selectedSummary = useMemo(() => {
    const queuedKeys = new Set([...queue, ...laterQueue].map((item: any) => `${item.objectType}:${item.objectId}`));
    const candidates = [...queue, ...laterQueue, ...objects.filter((item: any) => !queuedKeys.has(`${item.objectType}:${item.objectId}`))];
    if (!selectedKey) return null;
    return candidates.find((item: any) => `${item.objectType}:${item.objectId}` === selectedKey) || null;
  }, [laterQueue, objects, queue, selectedKey]);

  const loadDetail = async (summary = selectedSummary) => {
    const requestId = ++detailRequestId.current;
    if (!summary) { setDetail(null); setLoadingDetail(false); setLoadError(""); return; }
    setDetail(null);
    setLoadingDetail(true);
    setLoadError("");
    try {
      const value = await controlApi.getCatalogObject(summary.objectType, summary.objectId);
      if (requestId !== detailRequestId.current) return;
      setDetail(value);
      setObjectDraft(JSON.stringify(value.candidateVersion?.payload || value.algorithmCandidate || value.effectiveValue || {}, null, 2));
    } catch (error: any) {
      if (requestId !== detailRequestId.current) return;
      setLoadError(error.message || "审核对象加载失败");
    } finally {
      if (requestId === detailRequestId.current) setLoadingDetail(false);
    }
  };

  useEffect(() => { loadDetail(); }, [selectedSummary?.objectType, selectedSummary?.objectId, selectedSummary?.revision]);
  useEffect(() => { if (focusObject) setSelectedKey(`${focusObject.objectType}:${focusObject.objectId}`); }, [focusObject?.objectType, focusObject?.objectId]);

  const selectSummary = (entry: any) => {
    const key = `${entry.objectType}:${entry.objectId}`;
    if (selectedKey === key) loadDetail(entry);
    else setSelectedKey(key);
  };

  const fields = useMemo(() => Array.from(new Set([
    ...Object.keys(detail?.algorithmCandidate || {}),
    ...Object.keys(detail?.effectiveValue || {}),
    ...Object.keys(detail?.humanValues || {}),
  ])).sort(), [detail]);
  const visibleFields = useMemo(() => domainFields(detail), [detail]);
  const reviewCandidate = useMemo(() => reviewCandidateSnapshot(detail), [detail]);
  const visibleDifferences = useMemo(() => meaningfulDifferences(detail, visibleFields), [detail, visibleFields]);

  const completeReview = async (decision: "confirm" | "modify") => {
    if (!detail || !actor.trim()) { setMessage("请填写操作者"); return; }
    setBusy(true);
    try {
      const snapshot = decision === "confirm"
        ? structuredClone(reviewCandidate)
        : parseObjectDraft(objectDraft);
      const requestKey = `${detail.objectType}:${detail.objectId}:${detail.revision}:${decision}:${JSON.stringify(snapshot)}`;
      if (completionRequest.current?.key !== requestKey) {
        completionRequest.current = {
          key: requestKey,
          requestId: globalThis.crypto?.randomUUID?.() || `catalog-review-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        };
      }
      const updated = await controlApi.completeCatalogReview({
        objectType: detail.objectType, objectId: detail.objectId, decision,
        snapshot, actor: actor.trim(), ...(note.trim() ? { note: note.trim() } : {}),
        requestId: completionRequest.current.requestId,
        expectedRevision: detail.revision,
      });
      setDetail(updated);
      setLatestAuditSummary(updated.catalogAuditSummary || null);
      setObjectDraft(JSON.stringify(updated.candidateVersion?.payload || updated.algorithmCandidate || updated.effectiveValue || {}, null, 2));
      setNote("");
      completionRequest.current = null;
      const planningRecovered = updated.reviewResolution?.planningResult?.recovered === true;
      setMessage(planningRecovered
        ? "审核结论已保存，规划已经恢复"
        : "审核结论已保存，规划尚未恢复；请继续查看当前诊断");
      await onChanged();
      const currentKey = `${updated.objectType}:${updated.objectId}`;
      const nextEntry = queue.find((entry: any) => `${entry.objectType}:${entry.objectId}` !== currentKey);
      const nextReviewKey = updated.reviewStatus === "needs-review" || !planningRecovered
        ? currentKey
        : nextEntry ? `${nextEntry.objectType}:${nextEntry.objectId}` : null;
      setSelectedKey(nextReviewKey);
      if (nextReviewKey !== currentKey) setDetail(null);
    } catch (error: any) {
      if (error.payload?.currentObject) {
        setDetail(error.payload.currentObject);
        setObjectDraft(JSON.stringify(error.payload.currentObject.algorithmCandidate || error.payload.currentObject.effectiveValue || {}, null, 2));
      }
      setMessage(error.payload?.code === "CATALOG_REVISION_CONFLICT" ? "对象已被其他控制台修改；已加载最新版本，请重新核对完整对象" : error.message);
    } finally { setBusy(false); }
  };

  const setEvidenceDisposition = async (evidenceId: number, disposition: "eligible" | "paused" | "rejected") => {
    if (!detail || !note.trim() || !actor.trim()) { setMessage("处置证据前请填写操作者和审核备注"); return null; }
    const updated = await controlApi.setCatalogEvidenceDisposition({
      objectType: detail.objectType, objectId: detail.objectId, evidenceId, disposition,
      reason: `${actor.trim()}: ${note.trim()}`, expectedRevision: detail.revision,
    });
    setDetail(updated);
    setObjectDraft(JSON.stringify(updated.effectiveValue || updated.algorithmCandidate || {}, null, 2));
    return updated;
  };

  const updateEvidenceDisposition = async (evidenceId: number, disposition: "eligible" | "paused" | "rejected") => {
    setBusy(true);
    try {
      const updated = await setEvidenceDisposition(evidenceId, disposition);
      if (!updated) return;
      setNote("");
      setMessage(disposition === "eligible" ? "证据已恢复并重新评估" : disposition === "paused" ? "证据已暂停并重新评估" : "证据已否决并重新评估");
      await onChanged();
    } catch (error: any) {
      if (error.payload?.currentObject) setDetail(error.payload.currentObject);
      setMessage(error.message);
    } finally { setBusy(false); }
  };

  const acceptEvidence = async (evidenceId: number) => {
    if (!detail || !note.trim() || !actor.trim()) { setMessage("采用证据前请填写操作者和审核备注"); return; }
    setBusy(true);
    try {
      const conflictEvidenceIds = new Set<number>((detail.reviewReasons || [])
        .filter((reason: any) => reason.type === "evidence-conflict")
        .flatMap((reason: any) => (reason.details?.variants || []).flatMap((variant: any[]) => variant.map((item: any) => Number(item.evidenceId)))));
      let updated = detail;
      const selected = updated.evidence?.find((evidence: any) => Number(evidence.id) === Number(evidenceId));
      if (selected?.disposition !== "eligible") updated = await setEvidenceDisposition(evidenceId, "eligible") || updated;
      for (const evidence of updated.evidence || []) {
        if (Number(evidence.id) === Number(evidenceId) || evidence.disposition !== "eligible" || !conflictEvidenceIds.has(Number(evidence.id))) continue;
        updated = await controlApi.setCatalogEvidenceDisposition({
          objectType: updated.objectType, objectId: updated.objectId, evidenceId: evidence.id, disposition: "paused",
          reason: `${actor.trim()}: 采用证据 ${evidenceId}；${note.trim()}`, expectedRevision: updated.revision,
        });
      }
      setDetail(updated);
      setObjectDraft(JSON.stringify(updated.effectiveValue || updated.algorithmCandidate || {}, null, 2));
      setNote("");
      setMessage("已采用该证据，并暂停同一冲突中的其他候选证据");
      await onChanged();
    } catch (error: any) {
      if (error.payload?.currentObject) setDetail(error.payload.currentObject);
      setMessage(error.message);
    } finally { setBusy(false); }
  };

  const togglePause = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const disposition = detail.disposition === "paused" ? "enabled" : "paused";
      const updated = await controlApi.setCatalogObjectDisposition({ objectType: detail.objectType, objectId: detail.objectId, disposition, reason: disposition === "paused" ? "operator-paused-review" : "operator-resumed-review", expectedRevision: detail.revision });
      setDetail(updated);
      setMessage(disposition === "paused" ? "对象已暂停并立即退出真实规划" : "对象已恢复参与规划资格判断");
      onChanged();
    } catch (error: any) {
      if (error.payload?.currentObject) setDetail(error.payload.currentObject);
      setMessage(error.message);
    } finally { setBusy(false); }
  };

  const acquireIcon = async () => {
    if (!detail || detail.objectType !== "item-identity") return;
    setBusy(true);
    try {
      const task = await controlApi.acquireCatalogIcon(detail.objectId);
      setMessage(`图标采集任务 ${task.taskId} 已进入后台队列`);
    } catch (error: any) { setMessage(error.message); }
    finally { setBusy(false); }
  };

  const selectIcon = async (candidateId: number) => {
    if (!detail || !actor.trim()) { setMessage("选择图标前请填写操作员"); return; }
    const previousDetail = detail;
    const auditNote = note.trim() || "手动选择图标候选";
    setDetail(markIconSelected(detail, candidateId));
    setBusy(true);
    try {
      const updated = await controlApi.selectCatalogIcon({ objectId: detail.objectId, candidateId, actor: actor.trim(), note: auditNote, expectedRevision: detail.revision });
      setDetail(markIconSelected(updated, candidateId)); setNote(""); setMessage("已选择显示图标；人工选择优先于自动候选"); await onChanged();
    } catch (error: any) { setDetail(error.payload?.currentObject || previousDetail); setMessage(error.message); }
    finally { setBusy(false); }
  };

  const revokeIcon = async () => {
    if (!detail?.selectedIcon || !actor.trim() || !note.trim()) { setMessage("撤销图标前请填写操作员和备注"); return; }
    setBusy(true);
    try {
      const updated = await controlApi.revokeCatalogIcon({ objectId: detail.objectId, actor: actor.trim(), note: note.trim(), expectedRevision: detail.revision });
      setDetail(updated); setNote(""); setMessage("已撤销显示图标，历史候选仍完整保留"); onChanged();
    } catch (error: any) { if (error.payload?.currentObject) setDetail(error.payload.currentObject); setMessage(error.message); }
    finally { setBusy(false); }
  };

  const uploadIcon = async (file?: File) => {
    if (!detail || !file) return;
    if (!actor.trim() || !note.trim()) { setMessage("上传替代图标前请填写操作员和备注"); return; }
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      const updated = await controlApi.uploadCatalogIcon({ objectId: detail.objectId, actor: actor.trim(), note: note.trim(), expectedRevision: detail.revision, mimeType: file.type, dataBase64: dataUrl.split(",")[1] });
      setDetail(updated); setNote(""); setMessage("替代图标已上传并作为人工选择"); onChanged();
    } catch (error: any) { if (error.payload?.currentObject) setDetail(error.payload.currentObject); setMessage(error.message); }
    finally { if (iconUploadRef.current) iconUploadRef.current.value = ""; setBusy(false); }
  };

  return <>
    {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    <section className="catalog-review-workspace">
      <div className="panel review-queue">
        <div className="panel-head"><div><span className="eyebrow">语义审核</span><h2>待裁定对象</h2></div><b>{queue.length}</b></div>
        <p className="review-help">这里只显示会影响条目生效或需要人工取舍的原因。图标待补等完整性缺口放在“以后再看”，不影响当前规划。</p>
        <div className="review-queue-list">{queue.length ? queue.map((entry: any) => <button key={`${entry.objectType}:${entry.objectId}`} className={`${selectedKey === `${entry.objectType}:${entry.objectId}` ? "active" : ""}`} onClick={() => selectSummary(entry)}>
          <span><strong>{entry.displayTitle || "未命名物品"}</strong><small>{valueLabel(entry.objectType)} · {entry.actionStatus || "需要处理"}</small></span>
          <span className="reason-chips">{entry.reasons.map((reason: any, index: number) => <i className={reason.type} key={`${reason.type}-${index}`}>{reviewReasonMetadata[reason.type]?.label || reason.type}</i>)}</span>
        </button>) : <div className="empty-state compact"><Check/><span>当前没有待裁定对象</span></div>}</div>
        <details className="later-review-queue">
          <summary><span>以后再看</span><b>{laterQueue.length}</b></summary>
          <p>这里只收纳不影响当前规划的完整性缺口。</p>
          <div className="review-queue-list">{laterQueue.length ? laterQueue.map((entry: any) => <button key={`${entry.objectType}:${entry.objectId}`} className={`${selectedKey === `${entry.objectType}:${entry.objectId}` ? "active" : ""}`} onClick={() => selectSummary(entry)}>
            <span><strong>{entry.displayTitle || "未命名物品"}</strong><small>{valueLabel(entry.objectType)} · {entry.actionStatus}</small></span>
            <span className="reason-chips">{entry.gaps.map((gap: any, index: number) => <i className={gap.type} key={`${gap.type}-${index}`}>{reviewReasonMetadata[gap.type]?.label || gap.type}</i>)}</span>
          </button>) : <div className="empty-state compact"><Check/><span>当前没有待补对象</span></div>}</div>
        </details>
      </div>
      <div className="panel review-detail">
        {latestAuditSummary && <div className="catalog-audit-summary latest-audit-receipt"><strong>Catalog Audit Summary</strong><span>{latestAuditSummary.actor} 已{latestAuditSummary.action === "confirm" ? "确认完整候选" : "修改后确认"}“{latestAuditSummary.displayTitle}” · {latestAuditSummary.planningResult?.recovered ? "规划已恢复" : "规划尚未恢复"}</span></div>}
        {loadingDetail ? <div className="empty-state"><History className="spin"/><strong>正在加载审核对象…</strong><span>正在读取证据、版本和裁决记录</span></div> : !detail ? <div className="empty-state"><History/><strong>{loadError ? "审核对象加载失败" : "从审核队列选择对象"}</strong>{loadError && <><span>{loadError}</span><button className="ghost-btn" onClick={() => loadDetail()}>重试</button></>}</div> : <>
          <div className="panel-head">
            <div><span className="eyebrow">对象详情</span><h2>{catalogObjectTitle(detail, selectedSummary)}</h2><small>{valueLabel(detail.objectType)} · {selectedSummary?.actionStatus || (detail.reviewStatus === "needs-review" ? "需要处理" : "已确认")}</small></div>
            <div className="review-head-actions">{detail.objectType === "item-identity" && <button className="ghost-btn" disabled={busy} onClick={acquireIcon}><Image size={15}/>采集真实图标</button>}<button className="ghost-btn" disabled={busy} onClick={togglePause}>{detail.disposition === "paused" ? <><Play size={15}/>恢复对象</> : <><Pause size={15}/>暂停对象</>}</button></div>
          </div>
          <div className="human-review-reason"><AlertTriangle size={18}/><div><strong>{selectedSummary?.actionStatus === "以后再看" ? "为什么以后再看" : "为什么需要处理"}</strong><p>{humanReadableReason(detail)}</p></div></div>
          <div className="review-evidence-summary">
            <div><strong>证据摘要</strong><span>{detail.evidenceSummary?.evidenceCount || 0} 个来源记录 · {detail.evidenceSummary?.observationCount || 0} 次观测</span></div>
            <div className="reason-chips">{[...new Set((detail.evidenceSummary?.sources || []).map((source: any) => valueLabel(source.sourceType)))].map((source) => <i key={String(source)}>{String(source)}</i>)}</div>
          </div>
          {detail.objectType === "item-identity" && <div className={`selected-icon-preview ${detail.selectedIcon ? "available" : "missing"}`}>{detail.selectedIcon ? <img src={detail.selectedIcon.url} alt="物品展示图标" onClick={() => setLightboxSrc(detail.selectedIcon.url)}/> : <Image/>}<div><strong>{detail.selectedIcon ? "已取得真实图标" : "图标待采集"}</strong><span>{detail.selectedIcon ? `${detail.selectedIcon.width}×${detail.selectedIcon.height}，可用于区分同名对象` : "缺失仅影响视觉核对，不影响已生效字段参与规划"}</span></div></div>}
          {detail.objectType === "item-identity" && <div className="icon-candidate-review">
            <div className="icon-candidate-head"><div><h3>图标候选对比</h3><p>通过真实图标区分同名对象；识别评分和资源标识收在只读技术详情中。</p></div><div><button className="ghost-btn" disabled={busy} onClick={() => iconUploadRef.current?.click()}><Upload size={14}/>上传替代图标</button><input ref={iconUploadRef} hidden type="file" accept="image/png,image/jpeg" onChange={(event) => uploadIcon(event.target.files?.[0])}/><button className="ghost-btn danger" disabled={busy || !detail.selectedIcon} onClick={revokeIcon}><X size={14}/>撤销选择</button></div></div>
            <div className="icon-candidate-grid">{detail.iconCandidates?.length ? detail.iconCandidates.map((candidate: any, index: number) => <article className={candidate.selected ? "selected" : ""} key={candidate.id}><img src={candidate.url} alt={`候选图标 ${index + 1}`} onClick={() => setLightboxSrc(candidate.url)}/><div><strong>候选 {index + 1} · {valueLabel(candidate.sourceType)}</strong><span>{candidate.width} × {candidate.height} · {new Date(candidate.createdAt).toLocaleString()}</span></div><button disabled={busy || candidate.selected} onClick={() => selectIcon(candidate.id)}>{candidate.selected ? `当前选择 / ${valueLabel(candidate.selectionOrigin || "automatic")}` : "选择候选"}</button></article>) : <div className="empty-state compact"><Image/><span>暂无图标候选</span></div>}</div>
          </div>}
          {detail.reviewReasons?.length > 0 && <div className="review-alerts">{detail.reviewReasons.map((reason: any, index: number) => <span key={`${reason.type}-${index}`}><AlertTriangle size={14}/>{reviewReasonMetadata[reason.type]?.label || reason.type}{reason.fieldPath && visibleFields.includes(reason.fieldPath) ? ` · ${fieldLabel(reason.fieldPath)}` : ""}</span>)}</div>}
          {detail.completenessGaps?.length > 0 && <div className="completeness-gaps"><Image size={15}/><div><strong>以后再看：物品图标</strong><span>这属于完整性缺口，不进入主阻塞队列，不影响本次语义审核或当前规划。</span></div></div>}
          <div className="candidate-snapshot">
            <h3>本次将确认的完整候选</h3>
            <div className="candidate-facts">{visibleFields.length ? visibleFields.map((field) => <div key={field}><span>{fieldLabel(field)}</span><strong>{display(reviewCandidate[field])}</strong></div>) : <p>当前候选没有需要操作者核对的领域字段。</p>}</div>
          </div>
          <div className="meaningful-differences">
            <h3>有意义的差异</h3>
            {visibleDifferences.length ? visibleDifferences.map((difference) => <p key={difference.field}><strong>{fieldLabel(difference.field)}</strong><span>{display(difference.oldValue)} → {display(difference.newValue)}</span></p>) : <p>候选与当前生效的领域信息一致；本次只需确认语义审核原因。</p>}
          </div>
          {selectedSummary?.actionStatus !== "以后再看" && <div className="ruling-editor object-review-editor">
            <div className="wide review-resolution-help"><h3>完整对象审核</h3><p>“确认无误”会一次提交完整候选并自动生成审计摘要；普通确认无需填写备注。</p></div>
            <label><span>操作者</span><input value={actor} onChange={(event) => setActor(event.target.value)}/></label>
            <label><span>补充说明（选填）</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="确有需要时补充上下文"/></label>
            <div className="ruling-actions"><button disabled={busy} onClick={() => completeReview("confirm")}><Check size={15}/>确认无误</button><button disabled={busy} onClick={() => completeReview("modify")}><Save size={15}/>修改后确认</button></div>
            {message && <p className="review-message" role="status">{message}</p>}
            {detail.catalogAuditSummary && <div className="catalog-audit-summary wide"><strong>Catalog Audit Summary</strong><span>{detail.catalogAuditSummary.actor} 已{detail.catalogAuditSummary.action === "confirm" ? "确认完整候选" : "修改后确认"}“{detail.catalogAuditSummary.displayTitle}” · {detail.catalogAuditSummary.planningResult?.recovered ? "规划已恢复" : "规划尚未恢复"}</span></div>}
          </div>}
          <details className="technical-review-details">
            <summary>只读技术详情</summary>
            <div className="technical-identity"><strong>内部对象标识</strong><code>{detail.objectType}/{detail.objectId}</code></div>
            <label><span>完整对象 JSON</span><textarea value={objectDraft} readOnly spellCheck={false}/></label>
            <div className="field-table"><div className="field-row head"><span>字段</span><span>生效值</span><span>算法候选</span><span>人工值</span></div>{fields.map((field) => <div className="field-row" key={field}><strong>{fieldLabel(field)}</strong><span>{display(detail.effectiveValue?.[field])}</span><span>{display(detail.algorithmCandidate?.[field])}</span><span>{display(detail.humanValues?.[field]?.value)}</span></div>)}</div>
            <div className="technical-history-grid">
              <div><h3>完整证据历史</h3>{detail.evidence?.map((evidence: any) => <p key={evidence.id}><strong>{valueLabel(evidence.sourceType)} · {valueLabel(evidence.disposition)}</strong><span>{valueLabel(evidence.sourceRef || "runtime")} · {evidence.observationCount} 次</span><code>{display(evidence.payload)}</code></p>)}</div>
              <div><h3>裁决历史</h3>{detail.rulingHistory?.length ? [...detail.rulingHistory].reverse().map((ruling: any) => <p key={ruling.id}><strong>{ruling.fieldPath} · {valueLabel(ruling.decision)}</strong><span>{ruling.actor} · {new Date(ruling.createdAt).toLocaleString()} · {display(ruling.oldValue)} → {display(ruling.newValue)} · {ruling.note}</span></p>) : <p><span>暂无人工裁决</span></p>}</div>
              <div><h3>对象演变</h3>{[...(detail.transitions || [])].reverse().map((transition: any) => <p key={`transition-${transition.id}`}><strong>{valueLabel(transition.fromStatus)} → {valueLabel(transition.toStatus)}</strong><span>{new Date(transition.createdAt).toLocaleString()} · {valueLabel(transition.fromDisposition)} → {valueLabel(transition.toDisposition)} · {valueLabel(transition.reason)}</span></p>)}{[...(detail.versions || [])].reverse().map((version: any) => <p key={`version-${version.id}`}><strong>版本 {version.version} · {valueLabel(version.status)}</strong><span>{new Date(version.createdAt).toLocaleString()} · {valueLabel(version.origin)}</span><code>{display(version.payload)}</code></p>)}</div>
              {detail.objectType === "item-identity" && <div><h3>图标识别技术记录</h3>{detail.iconCandidates?.map((candidate: any) => <p key={candidate.id}><code>{display(candidate)}</code></p>)}{detail.iconSelectionHistory?.map((entry: any) => <p key={entry.id}><code>{display(entry)}</code></p>)}</div>}
            </div>
          </details>
          <details className="advanced-review-actions">
            <summary>高级诊断与证据处置</summary>
            <div className="review-evidence"><div><h3>证据采用与否决</h3>{detail.evidence?.map((evidence: any, index: number) => <p key={evidence.id}><strong>证据 {index + 1} · {valueLabel(evidence.sourceType)}</strong><span>{evidence.observationCount} 次 · {valueLabel(evidence.disposition)}</span><span className="evidence-actions"><button disabled={busy} onClick={() => acceptEvidence(evidence.id)}>采用证据</button>{evidence.disposition === "eligible" ? <><button disabled={busy} onClick={() => updateEvidenceDisposition(evidence.id, "paused")}>暂停证据</button><button className="danger" disabled={busy} onClick={() => updateEvidenceDisposition(evidence.id, "rejected")}>否决证据</button></> : <button disabled={busy} onClick={() => updateEvidenceDisposition(evidence.id, "eligible")}><RotateCcw size={13}/>恢复证据</button>}</span></p>)}</div></div>
          </details>
        </>}
      </div>
    </section>
  </>;
}
