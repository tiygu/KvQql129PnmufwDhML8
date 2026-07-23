import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, History, Image, Pause, Play, RotateCcw, Save, Upload, X } from "lucide-react";
import { controlApi } from "./control-api";

const reasonLabels: Record<string, string> = {
  "new-observation": "新观测",
  "inference-change": "推断变化",
  "evidence-conflict": "证据冲突",
  "icon-gap": "图标缺口",
  "human-ruling-conflict": "裁决冲突",
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
  const iconUploadRef = useRef<HTMLInputElement>(null);
  const detailRequestId = useRef(0);

  const selectedSummary = useMemo(() => {
    const queuedKeys = new Set(queue.map((item: any) => `${item.objectType}:${item.objectId}`));
    const candidates = [...queue, ...objects.filter((item: any) => !queuedKeys.has(`${item.objectType}:${item.objectId}`))];
    if (!selectedKey) return null;
    return candidates.find((item: any) => `${item.objectType}:${item.objectId}` === selectedKey) || null;
  }, [objects, queue, selectedKey]);

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
      setObjectDraft(JSON.stringify(value.effectiveValue || value.algorithmCandidate || {}, null, 2));
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

  const completeReview = async (decision: "confirm" | "modify") => {
    if (!detail || !note.trim() || !actor.trim()) { setMessage("请填写操作者和审核备注"); return; }
    setBusy(true);
    try {
      const payload = decision === "modify" ? parseObjectDraft(objectDraft) : undefined;
      const updated = await controlApi.completeCatalogReview({
        objectType: detail.objectType, objectId: detail.objectId, decision,
        ...(payload ? { payload } : {}), actor: actor.trim(), note: note.trim(), expectedRevision: detail.revision,
      });
      setDetail(updated);
      setObjectDraft(JSON.stringify(updated.effectiveValue || {}, null, 2));
      setNote("");
      setMessage(updated.reviewStatus === "clear" ? "整对象审核已完成，已从待裁定队列移出" : "整对象已生效；仍有证据冲突需要处置");
      await onChanged();
      const currentKey = `${updated.objectType}:${updated.objectId}`;
      const nextEntry = queue.find((entry: any) => `${entry.objectType}:${entry.objectId}` !== currentKey);
      const nextReviewKey = updated.reviewStatus === "needs-review"
        ? currentKey
        : nextEntry ? `${nextEntry.objectType}:${nextEntry.objectId}` : null;
      setSelectedKey(nextReviewKey);
      if (nextReviewKey !== currentKey) setDetail(null);
    } catch (error: any) {
      if (error.payload?.currentObject) {
        setDetail(error.payload.currentObject);
        setObjectDraft(JSON.stringify(error.payload.currentObject.effectiveValue || error.payload.currentObject.algorithmCandidate || {}, null, 2));
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

  return <section className="catalog-review-workspace">
    <div className="panel review-queue">
      <div className="panel-head"><div><span className="eyebrow">语义审核</span><h2>待裁定对象</h2></div><b>{queue.length}</b></div>
      <p className="review-help">这里只显示会影响条目生效或需要人工取舍的原因。图标待补不占用审核队列，也不阻止规划。</p>
      <div className="review-queue-list">{queue.length ? queue.map((entry: any) => <button key={`${entry.objectType}:${entry.objectId}`} className={`${selectedKey === `${entry.objectType}:${entry.objectId}` ? "active" : ""}`} onClick={() => selectSummary(entry)}>
        <span><strong>{entry.objectId}</strong><small>{valueLabel(entry.objectType)} · 证据成熟度：{valueLabel(entry.status)} · 规划资格：{valueLabel(entry.disposition)} · 版本 {entry.revision}</small></span>
        <span className="reason-chips">{entry.reasons.map((reason: any, index: number) => <i className={reason.type} key={`${reason.type}-${index}`}>{reasonLabels[reason.type] || reason.type}</i>)}</span>
      </button>) : <div className="empty-state compact"><Check/><span>当前没有待裁定对象</span></div>}</div>
    </div>
    <div className="panel review-detail">
      {loadingDetail ? <div className="empty-state"><History className="spin"/><strong>正在加载审核对象…</strong><span>正在读取证据、版本和裁决记录</span></div> : !detail ? <div className="empty-state"><History/><strong>{loadError ? "审核对象加载失败" : "从审核队列选择对象"}</strong>{loadError && <><span>{loadError}</span><button className="ghost-btn" onClick={() => loadDetail()}>重试</button></>}</div> : <>
        <div className="panel-head"><div><span className="eyebrow">对象详情</span><h2>{detail.objectId}</h2><small>{valueLabel(detail.objectType)} · 证据成熟度：{valueLabel(detail.status)} · 规划资格：{valueLabel(detail.disposition)} · 版本 {detail.revision}</small></div><div className="review-head-actions">{detail.objectType === "item-identity" && <button className="ghost-btn" disabled={busy} onClick={acquireIcon}><Image size={15}/>采集真实图标</button>}<button className="ghost-btn" disabled={busy} onClick={togglePause}>{detail.disposition === "paused" ? <><Play size={15}/>恢复对象</> : <><Pause size={15}/>暂停对象</>}</button></div></div>
        {detail.objectType === "item-identity" && <div className={`selected-icon-preview ${detail.selectedIcon ? "available" : "missing"}`}>{detail.selectedIcon ? <img src={detail.selectedIcon.url} alt={`${detail.objectId} icon`}/> : <Image/>}<div><strong>{detail.selectedIcon ? "精确运行时图标" : "图标待采集"}</strong><span>{detail.selectedIcon ? `${detail.selectedIcon.assetHash} · ${detail.selectedIcon.width}×${detail.selectedIcon.height}` : "缺失仅影响视觉核对，不影响其他 Active 字段参与规划"}</span></div></div>}
        {detail.objectType === "item-identity" && <div className="icon-candidate-review">
          <div className="icon-candidate-head"><div><h3>图标候选对比</h3><p>资源、截图和上传证据都会保留，可随时复核。</p></div><div><button className="ghost-btn" disabled={busy} onClick={() => iconUploadRef.current?.click()}><Upload size={14}/>上传替代图标</button><input ref={iconUploadRef} hidden type="file" accept="image/png,image/jpeg" onChange={(event) => uploadIcon(event.target.files?.[0])}/><button className="ghost-btn danger" disabled={busy || !detail.selectedIcon} onClick={revokeIcon}><X size={14}/>撤销选择</button></div></div>
          <div className="icon-candidate-grid">{detail.iconCandidates?.length ? detail.iconCandidates.map((candidate: any) => <article className={candidate.selected ? "selected" : ""} key={candidate.id}><img src={candidate.url} alt={`候选图标 ${candidate.id}`}/><div><strong>{valueLabel(candidate.sourceType)}</strong><span>{candidate.width} × {candidate.height} / {new Date(candidate.createdAt).toLocaleString()}</span><span className="candidate-hash">{candidate.assetHash}</span>{candidate.resourceUrl && <span className="candidate-hash">资源地址：{candidate.resourceUrl}</span>}<span>裁剪：{candidate.crop?.pixelCrop ? `${candidate.crop.pixelCrop.x},${candidate.crop.pixelCrop.y} ${candidate.crop.pixelCrop.width}×${candidate.crop.pixelCrop.height}` : candidate.crop?.rect ? `${candidate.crop.rect.x},${candidate.crop.rect.y} ${candidate.crop.rect.width}×${candidate.crop.rect.height}` : "完整图像"}</span>{candidate.similarity?.frameSelection && <span>稳定帧：{candidate.similarity.frameSelection.acceptedFrameIndexes.length}/{candidate.similarity.frameSelection.frameHashes.length} / {valueLabel(candidate.similarity.frameSelection.reason)}</span>}{candidate.similarity?.comparisons?.[0] && <span>最佳匹配：{(candidate.similarity.comparisons[0].composite * 100).toFixed(1)}% / 感知 {(candidate.similarity.comparisons[0].metrics.perceptualHash * 100).toFixed(0)} / 结构 {(candidate.similarity.comparisons[0].metrics.structure * 100).toFixed(0)} / 色彩 {(candidate.similarity.comparisons[0].metrics.colorHistogram * 100).toFixed(0)} / 轮廓 {(candidate.similarity.comparisons[0].metrics.transparentContour * 100).toFixed(0)}</span>}</div><button disabled={busy || candidate.selected} onClick={() => selectIcon(candidate.id)}>{candidate.selected ? `当前选择 / ${valueLabel(candidate.selectionOrigin || "automatic")}` : "选择候选"}</button></article>) : <div className="empty-state compact"><Image/><span>暂无图标候选</span></div>}</div>
          {detail.iconSelectionHistory?.length > 0 && <div className="icon-selection-history"><h4>图标选择历史</h4>{[...detail.iconSelectionHistory].reverse().map((entry: any) => <p key={entry.id}><strong>{valueLabel(entry.action)}</strong><span>{entry.actor} / {new Date(entry.createdAt).toLocaleString()} / {entry.assetHash || "未选择"} / {entry.note}</span></p>)}</div>}
        </div>}
        {detail.reviewReasons?.length > 0 && <div className="review-alerts">{detail.reviewReasons.map((reason: any, index: number) => <span key={`${reason.type}-${index}`}><AlertTriangle size={14}/>{reasonLabels[reason.type] || reason.type}{reason.fieldPath ? ` · ${reason.fieldPath}` : ""}</span>)}</div>}
        {detail.completenessGaps?.length > 0 && <div className="completeness-gaps"><Image size={15}/><div><strong>数据待补：物品图标</strong><span>这属于完整性缺口，不影响本次语义审核完成，也不影响已生效字段参与规划。</span></div></div>}
        <div className="field-table"><div className="field-row head"><span>字段</span><span>生效值</span><span>算法候选</span><span>人工值</span></div>{fields.map((field) => <div className="field-row" key={field}><strong>{fieldLabel(field)}</strong><span>{display(detail.effectiveValue?.[field])}</span><span>{display(detail.algorithmCandidate?.[field])}</span><span>{display(detail.humanValues?.[field]?.value)}</span></div>)}</div>
        <div className="ruling-editor object-review-editor"><div className="wide review-resolution-help"><h3>完整对象审核</h3><p>“确认完整候选”会原样接受服务端当前候选；如需修正，请在下方编辑完整 JSON 后保存整项修改。两个操作都会创建人工生效版本。</p></div><label className="wide"><span>完整对象 JSON</span><textarea value={objectDraft} onChange={(event) => setObjectDraft(event.target.value)} spellCheck={false}/></label><label><span>操作者</span><input value={actor} onChange={(event) => setActor(event.target.value)}/></label><label><span>审核备注</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录核对依据或修改原因"/></label><div className="ruling-actions"><button disabled={busy} onClick={() => completeReview("confirm")}><Check size={15}/>确认完整候选并完成审核</button><button disabled={busy} onClick={() => completeReview("modify")}><Save size={15}/>保存整项修改并完成审核</button></div>{message && <p className="review-message">{message}</p>}</div>
        <div className="review-evidence"><div><h3>证据来源与处置</h3>{detail.evidence?.map((evidence: any) => <p key={evidence.id}><strong>{valueLabel(evidence.sourceType)}</strong><span>{valueLabel(evidence.sourceRef || "runtime")} · {evidence.observationCount} 次 · {valueLabel(evidence.disposition)}</span><span>{display(evidence.payload)}</span><span className="evidence-actions"><button disabled={busy} onClick={() => acceptEvidence(evidence.id)}>采用证据</button>{evidence.disposition === "eligible" ? <><button disabled={busy} onClick={() => updateEvidenceDisposition(evidence.id, "paused")}>暂停证据</button><button className="danger" disabled={busy} onClick={() => updateEvidenceDisposition(evidence.id, "rejected")}>否决证据</button></> : <button disabled={busy} onClick={() => updateEvidenceDisposition(evidence.id, "eligible")}><RotateCcw size={13}/>恢复证据</button>}</span></p>)}</div><div><h3>裁决历史</h3>{detail.rulingHistory?.length ? [...detail.rulingHistory].reverse().map((ruling: any) => <p key={ruling.id}><strong>{ruling.fieldPath} · {valueLabel(ruling.decision)}</strong><span>{ruling.actor} · {new Date(ruling.createdAt).toLocaleString()} · {display(ruling.oldValue)} → {display(ruling.newValue)} · {ruling.note}</span></p>) : <p><span>暂无人工裁决</span></p>}</div><div><h3>对象演变</h3>{[...(detail.transitions || [])].reverse().map((transition: any) => <p key={`transition-${transition.id}`}><strong>{valueLabel(transition.fromStatus)} → {valueLabel(transition.toStatus)}</strong><span>{new Date(transition.createdAt).toLocaleString()} · {valueLabel(transition.fromDisposition)} → {valueLabel(transition.toDisposition)} · {valueLabel(transition.reason)}</span></p>)}{[...(detail.versions || [])].reverse().map((version: any) => <p key={`version-${version.id}`}><strong>版本 {version.version} · {valueLabel(version.status)}</strong><span>{new Date(version.createdAt).toLocaleString()} · {valueLabel(version.origin)} · {display(version.payload)}</span></p>)}</div></div>
      </>}
    </div>
  </section>;
}
