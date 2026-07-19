import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, History, Image, Pause, Play, RotateCcw, Save } from "lucide-react";
import { controlApi } from "./control-api";

const reasonLabels: Record<string, string> = {
  "new-observation": "新观测",
  "inference-change": "推断变化",
  "evidence-conflict": "证据冲突",
  "icon-gap": "图标缺口",
  "human-ruling-conflict": "裁决冲突",
};

function display(value: any) {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function parseDraft(value: string) {
  try { return JSON.parse(value); } catch { return value; }
}

export function CatalogReviewWorkspace({ repository, onChanged }: { repository: any; onChanged: (catalog?: any) => void }) {
  const queue = repository?.reviewQueue || [];
  const objects = repository?.objects || [];
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [fieldPath, setFieldPath] = useState("");
  const [draft, setDraft] = useState("");
  const [actor, setActor] = useState("local-operator");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedSummary = useMemo(() => {
    const candidates = queue.length ? queue : objects;
    return candidates.find((item: any) => `${item.objectType}:${item.objectId}` === selectedKey) || candidates[0] || null;
  }, [objects, queue, selectedKey]);

  const loadDetail = async (summary = selectedSummary) => {
    if (!summary) { setDetail(null); return; }
    const value = await controlApi.getCatalogObject(summary.objectType, summary.objectId);
    setDetail(value);
    const firstField = fieldPath || Object.keys(value.effectiveValue || {})[0] || "";
    setFieldPath(firstField);
    setDraft(display(value.effectiveValue?.[firstField]));
  };

  useEffect(() => { loadDetail().catch((error) => setMessage(error.message)); }, [selectedSummary?.objectType, selectedSummary?.objectId, selectedSummary?.revision]);

  const fields = useMemo(() => Array.from(new Set([
    ...Object.keys(detail?.algorithmCandidate || {}),
    ...Object.keys(detail?.effectiveValue || {}),
    ...Object.keys(detail?.humanValues || {}),
  ])).sort(), [detail]);

  const selectField = (next: string) => {
    setFieldPath(next);
    setDraft(display(detail?.effectiveValue?.[next]));
  };

  const commit = async (decision: "confirm" | "modify") => {
    if (!detail || !fieldPath || !note.trim() || !actor.trim()) { setMessage("请填写字段、操作者和备注"); return; }
    setBusy(true);
    try {
      const value = decision === "confirm" ? detail.algorithmCandidate?.[fieldPath] : parseDraft(draft);
      const updated = await controlApi.applyCatalogRuling({
        objectType: detail.objectType, objectId: detail.objectId, fieldPath, decision, value,
        actor: actor.trim(), note: note.trim(), expectedRevision: detail.revision,
        baseRulingId: detail.humanValues?.[fieldPath]?.id ?? null,
      });
      setDetail(updated);
      setDraft(display(updated.effectiveValue?.[fieldPath]));
      setNote("");
      setMessage(updated.mergedStaleRevision ? "其他字段已变化；当前字段已安全合并" : "字段裁决已保存");
      onChanged();
    } catch (error: any) {
      if (error.payload?.code === "CATALOG_REVISION_CONFLICT" && error.payload.currentObject) {
        const current = error.payload.currentObject;
        const rulingUnchanged = (current.humanValues?.[fieldPath]?.id ?? null) === (detail.humanValues?.[fieldPath]?.id ?? null);
        const candidateUnchanged = JSON.stringify(current.algorithmCandidate?.[fieldPath] ?? null) === JSON.stringify(detail.algorithmCandidate?.[fieldPath] ?? null);
        if (rulingUnchanged && candidateUnchanged) {
          try {
            const value = decision === "confirm" ? current.algorithmCandidate?.[fieldPath] : parseDraft(draft);
            const updated = await controlApi.applyCatalogRuling({ objectType: current.objectType, objectId: current.objectId, fieldPath, decision, value, actor: actor.trim(), note: note.trim(), expectedRevision: current.revision, baseRulingId: current.humanValues?.[fieldPath]?.id ?? null });
            setDetail(updated);
            setDraft(display(updated.effectiveValue?.[fieldPath]));
            setNote("");
            setMessage("已重载最新 revision，并重新提交未冲突字段");
            onChanged();
          } catch (retryError: any) {
            setDetail(retryError.payload?.currentObject || current);
            setMessage("重提交期间 revision 再次变化；请核对最新值");
          }
        } else {
          setDetail(current);
          setMessage("同一字段或算法候选已变化；已重载最新值，请核对后重新提交");
        }
      } else setMessage(error.message);
    } finally { setBusy(false); }
  };

  const revoke = async () => {
    if (!detail?.humanValues?.[fieldPath] || !note.trim() || !actor.trim()) { setMessage("请选择已有裁决的字段并填写操作者和备注"); return; }
    setBusy(true);
    try {
      const updated = await controlApi.revokeCatalogRuling({
        objectType: detail.objectType, objectId: detail.objectId, fieldPath,
        actor: actor.trim(), note: note.trim(), expectedRevision: detail.revision,
        baseRulingId: detail.humanValues[fieldPath].id,
      });
      setDetail(updated);
      setDraft(display(updated.effectiveValue?.[fieldPath]));
      setNote("");
      setMessage("裁决已撤销，当前算法候选已恢复显示");
      onChanged();
    } catch (error: any) {
      if (error.payload?.currentObject) setDetail(error.payload.currentObject);
      setMessage(error.payload?.code === "CATALOG_REVISION_CONFLICT" ? "字段已被其他控制台修改；请核对最新值" : error.message);
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

  return <section className="catalog-review-workspace">
    <div className="panel review-queue">
      <div className="panel-head"><div><span className="eyebrow">Catalog Review Queue</span><h2>审核队列</h2></div><b>{queue.length}</b></div>
      <p className="review-help">集中显示新观测、推断变化、证据冲突、图标缺口和人工裁决冲突。</p>
      <div className="review-queue-list">{queue.length ? queue.map((entry: any) => <button key={`${entry.objectType}:${entry.objectId}`} className={`${selectedSummary?.objectType === entry.objectType && selectedSummary?.objectId === entry.objectId ? "active" : ""}`} onClick={() => setSelectedKey(`${entry.objectType}:${entry.objectId}`)}>
        <span><strong>{entry.objectId}</strong><small>{entry.objectType} · r{entry.revision}</small></span>
        <span className="reason-chips">{entry.reasons.map((reason: any, index: number) => <i className={reason.type} key={`${reason.type}-${index}`}>{reasonLabels[reason.type] || reason.type}</i>)}</span>
      </button>) : <div className="empty-state compact"><Check/><span>当前没有待审核项</span></div>}</div>
    </div>
    <div className="panel review-detail">
      {!detail ? <div className="empty-state"><History/><span>从审核队列选择对象</span></div> : <>
        <div className="panel-head"><div><span className="eyebrow">对象详情</span><h2>{detail.objectId}</h2><small>{detail.objectType} · {detail.status} · r{detail.revision}</small></div><div className="review-head-actions">{detail.objectType === "item-identity" && <button className="ghost-btn" disabled={busy} onClick={acquireIcon}><Image size={15}/>采集真实图标</button>}<button className="ghost-btn" disabled={busy} onClick={togglePause}>{detail.disposition === "paused" ? <><Play size={15}/>恢复对象</> : <><Pause size={15}/>暂停对象</>}</button></div></div>
        {detail.objectType === "item-identity" && <div className={`selected-icon-preview ${detail.selectedIcon ? "available" : "missing"}`}>{detail.selectedIcon ? <img src={detail.selectedIcon.url} alt={`${detail.objectId} icon`}/> : <Image/>}<div><strong>{detail.selectedIcon ? "精确运行时图标" : "图标待采集"}</strong><span>{detail.selectedIcon ? `${detail.selectedIcon.assetHash} · ${detail.selectedIcon.width}×${detail.selectedIcon.height}` : "缺失仅影响视觉核对，不影响其他 Active 字段参与规划"}</span></div></div>}
        {detail.reviewReasons?.length > 0 && <div className="review-alerts">{detail.reviewReasons.map((reason: any, index: number) => <span key={`${reason.type}-${index}`}><AlertTriangle size={14}/>{reasonLabels[reason.type] || reason.type}{reason.fieldPath ? ` · ${reason.fieldPath}` : ""}</span>)}</div>}
        <div className="field-table"><div className="field-row head"><span>字段</span><span>生效值</span><span>算法候选</span><span>人工值</span></div>{fields.map((field) => <button className={`field-row ${fieldPath === field ? "active" : ""}`} key={field} onClick={() => selectField(field)}><strong>{field}</strong><span>{display(detail.effectiveValue?.[field])}</span><span>{display(detail.algorithmCandidate?.[field])}</span><span>{display(detail.humanValues?.[field]?.value)}</span></button>)}</div>
        <div className="ruling-editor"><label><span>字段</span><select value={fieldPath} onChange={(event) => selectField(event.target.value)}>{fields.map((field) => <option key={field}>{field}</option>)}</select></label><label className="wide"><span>人工值（JSON 或文本）</span><textarea value={draft} onChange={(event) => setDraft(event.target.value)}/></label><label><span>操作者</span><input value={actor} onChange={(event) => setActor(event.target.value)}/></label><label><span>备注</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录判断依据"/></label><div className="ruling-actions"><button disabled={busy} onClick={() => commit("confirm")}><Check size={15}/>确认候选</button><button disabled={busy} onClick={() => commit("modify")}><Save size={15}/>保存修改</button><button disabled={busy || !detail.humanValues?.[fieldPath]} onClick={revoke}><RotateCcw size={15}/>撤销裁决</button></div>{message && <p className="review-message">{message}</p>}</div>
        <div className="review-evidence"><div><h3>证据来源</h3>{detail.evidence?.map((evidence: any) => <p key={evidence.id}><strong>{evidence.sourceType}</strong><span>{evidence.sourceRef || "runtime"} · {evidence.observationCount} 次 · {evidence.disposition}</span></p>)}</div><div><h3>裁决历史</h3>{detail.rulingHistory?.length ? [...detail.rulingHistory].reverse().map((ruling: any) => <p key={ruling.id}><strong>{ruling.fieldPath} · {ruling.decision}</strong><span>{ruling.actor} · {new Date(ruling.createdAt).toLocaleString()} · {display(ruling.oldValue)} → {display(ruling.newValue)} · {ruling.note}</span></p>) : <p><span>暂无人工裁决</span></p>}</div><div><h3>对象演变</h3>{[...(detail.transitions || [])].reverse().map((transition: any) => <p key={`transition-${transition.id}`}><strong>{transition.fromStatus} → {transition.toStatus}</strong><span>{new Date(transition.createdAt).toLocaleString()} · {transition.fromDisposition} → {transition.toDisposition} · {transition.reason}</span></p>)}{[...(detail.versions || [])].reverse().map((version: any) => <p key={`version-${version.id}`}><strong>v{version.version} · {version.status}</strong><span>{new Date(version.createdAt).toLocaleString()} · {version.origin} · {display(version.payload)}</span></p>)}</div></div>
      </>}
    </div>
  </section>;
}
