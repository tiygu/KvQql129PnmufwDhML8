import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, History, Image, Pause, Play, RotateCcw, Save, SkipForward, Upload, X } from "lucide-react";
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
  "production-attribution-conflict": {
    label: "产出归因冲突",
    explanation: "真实产出动作的来源或所属产出物归因互相矛盾，候选产物暂不自动扩展。请核对完整产出档案快照。",
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
  observation: "观察",
  assisted: "协助",
  automatic: "自动",
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
  mergeTarget: "结果物",
  requiredCount: "所需数量",
  producerId: "产出物编号",
  producerItemId: "所属产出物",
  candidateOutputs: "候选产物集合",
  productionModes: "可用产出档位",
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
  "production-profile": ["candidateOutputs", "productionModes"],
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
  return snapshotDifferences(baseline, candidate, fields);
}

function identityDraftFromDetail(detail: any) {
  const candidate = reviewCandidateSnapshot(detail);
  return identityDraftFromPayload(candidate);
}

function identityDraftFromPayload(candidate: any) {
  return {
    name: candidate.name == null ? "" : String(candidate.name),
    level: candidate.level == null ? "" : String(candidate.level),
    type: candidate.type == null ? "" : String(candidate.type),
  };
}

function itemIdentitySnapshot(candidate: any, draft: { name: string; level: string; type: string }, selectedIcon: any) {
  const levelText = draft.level.trim();
  const snapshot: any = {
    ...structuredClone(candidate),
    name: draft.name.trim() || null,
    level: levelText ? Number(levelText) : null,
    type: draft.type.trim() || null,
  };
  if (selectedIcon || Object.hasOwn(candidate, "displayIcon")) {
    snapshot.displayIcon = selectedIcon
      ? { candidateId: Number(selectedIcon.id), assetHash: selectedIcon.assetHash }
      : candidate.displayIcon;
  }
  return snapshot;
}

function snapshotDifferences(before: any, after: any, fields: string[]) {
  return fields.flatMap((field) => display(before?.[field] ?? null) === display(after?.[field] ?? null)
    ? []
    : [{ field, oldValue: before?.[field] ?? null, newValue: after?.[field] ?? null }]);
}

function relationDraftFromDetail(detail: any) {
  const candidate = reviewCandidateSnapshot(detail);
  return relationDraftFromPayload(candidate);
}

function relationDraftFromPayload(candidate: any) {
  return {
    requiredCount: String(candidate.requiredCount ?? 2),
    mergeTarget: candidate.mergeTarget == null ? "" : String(candidate.mergeTarget),
  };
}

function relationItemLabel(item: any) {
  return `${item?.name || "未命名物品"}（${item?.level == null ? "等级未知" : `第 ${item.level} 级`}）`;
}

function productionProfileItemLabel(item: any) {
  return `${item?.name || "未命名物品"}（${item?.level == null ? "等级未知" : `第 ${item.level} 级`}）`;
}

function productionDistributionItemLabel(context: any, itemId: any) {
  const item = context?.items?.[String(itemId)] || {};
  return `${item.name || "未命名物品"}${item.level == null ? "" : `（第 ${item.level} 级）`}`;
}

function percentage(value: any) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "未知";
}

function planningBasisLabel(value: any) {
  return value === "conservative-feasibility" ? "保守可行性" : "后验期望";
}

function relationObjectKey(item: any) {
  return item?.objectId || "";
}

function relationValidationError(source: any, target: any, requiredCount: string) {
  if (Number(requiredCount) !== 2) return `所需数量错误：“${relationItemLabel(source)}”每次必须使用 2 个同级物品。`;
  if (!target) return `链条断裂：“${relationItemLabel(source)}”的结果物尚未取得可靠身份线索。`;
  if (target.objectId === source?.objectId) return `自环错误：“${relationItemLabel(source)}”不能合成为自身。`;
  if (source?.level != null && target.level != null && target.level <= source.level) {
    return `等级倒退：“${relationItemLabel(source)}”不能指向“${relationItemLabel(target)}”。`;
  }
  if (source?.chainId !== target.chainId || source?.level == null || target.level == null || target.level !== source.level + 1) {
    const expected = source?.level == null ? "下一等级" : `第 ${source.level + 1} 级`;
    return `链条断裂：“${relationItemLabel(source)}”应连接同一合成链的${expected}，当前选择“${relationItemLabel(target)}”。`;
  }
  return "";
}

function humanReadableReason(detail: any) {
  if (waitingForMergeObservation(detail)) return "这个合成结果还没有在真实订单推进中出现；结果字段保持只读，请返回自动化继续收集线索。";
  const planningResult = detail?.reviewResolution?.planningResult;
  if (planningResult && planningResult.recovered !== true) return reviewReasonMetadata["planning-recovery-pending"].explanation;
  const reasons = detail?.reviewReasons || [];
  if (detail?.objectType === "production-profile"
    && reasons.some((entry: any) => entry.type === "production-attribution-conflict")) {
    return reviewReasonMetadata["production-attribution-conflict"].explanation;
  }
  const priority = ["planning-recovery-pending", "evidence-conflict", "human-ruling-conflict", "inference-change", "new-observation"];
  const reason = priority.find((type) => reasons.some((entry: any) => entry.type === type));
  if (reason) return reviewReasonMetadata[reason].explanation;
  if (detail?.completenessGaps?.length) return reviewReasonMetadata["icon-gap"].explanation;
  return reviewReasonMetadata["new-observation"].explanation;
}

function waitingForMergeObservation(detail: any) {
  if (detail?.objectType !== "merge-relation") return false;
  const candidate = detail?.algorithmCandidate || detail?.effectiveValue || {};
  const hasInference = (detail?.evidence || []).some((evidence: any) => evidence.disposition !== "rejected" && evidence.sourceType === "structural-inference");
  const hasVerifiedMerge = (detail?.evidence || []).some((evidence: any) => evidence.disposition !== "rejected"
    && evidence.sourceType === "passive-action-diff" && evidence.payload?.mergeTarget != null);
  const target = (detail?.relationContext?.items || []).find((item: any) => item.objectId === candidate.mergeTarget);
  return hasInference && !hasVerifiedMerge && (!candidate.mergeTarget || !target || target.reviewStatus !== "clear");
}

function planningBoundaryText(boundaryReason: any) {
  const explanations: Record<string, string> = {
    "evidence-waiting": "当前订单仍在等待图鉴证据",
    "catalog-review-replan-failed": "重新规划执行失败",
    "inventory-unavailable": "当前订单仍缺少可用库存",
    "insufficient-energy": "当前订单仍受体力不足影响",
    "board-space-deadlock": "当前订单仍受棋盘空间限制",
    "no-feasible-order": "当前还没有可执行订单",
  };
  return explanations[String(boundaryReason || "")] || "当前订单仍受重新规划结果阻塞";
}

function catalogAuditSummarySentence(summary: any) {
  const action = summary?.action === "confirm"
    ? "确认完整候选"
    : summary?.action === "modify"
      ? "修改后确认"
      : summary?.action === "accept-evidence"
        ? "采用证据"
        : summary?.action === "reject-evidence"
          ? "否决证据"
          : summary?.action === "pause-evidence" ? "暂停证据" : "恢复证据";
  const result = summary?.planningResult
    ? summary.planningResult.recovered ? "规划已恢复" : "规划尚未恢复"
    : ["accept-evidence", "reject-evidence"].includes(summary?.action) ? "对象仍待完整确认" : "证据已重新评估";
  return `${summary?.actor || "系统"} 已${action}“${summary?.displayTitle || "未命名对象"}” · ${result}`;
}

function parseObjectDraft(value: string) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("完整对象必须是 JSON 对象");
  return parsed;
}

const LOCAL_REVIEW_DRAFTS_KEY = "catalog-review-local-drafts-v1";
const LOCAL_REVIEW_SELECTION_KEY = "catalog-review-selected-object-v1";

function readLocalReviewDraft(objectKey: string) {
  try {
    const drafts = JSON.parse(globalThis.localStorage?.getItem(LOCAL_REVIEW_DRAFTS_KEY) || "{}");
    return drafts?.[objectKey] || null;
  } catch (_) {
    return null;
  }
}

function writeLocalReviewDraft(objectKey: string, draft: any) {
  try {
    const drafts = JSON.parse(globalThis.localStorage?.getItem(LOCAL_REVIEW_DRAFTS_KEY) || "{}");
    globalThis.localStorage?.setItem(LOCAL_REVIEW_DRAFTS_KEY, JSON.stringify({ ...drafts, [objectKey]: draft }));
  } catch (_) {}
}

function removeLocalReviewDraft(objectKey: string) {
  try {
    const drafts = JSON.parse(globalThis.localStorage?.getItem(LOCAL_REVIEW_DRAFTS_KEY) || "{}");
    delete drafts[objectKey];
    globalThis.localStorage?.setItem(LOCAL_REVIEW_DRAFTS_KEY, JSON.stringify(drafts));
  } catch (_) {}
}

function localDraftDifferences(before: any, after: any) {
  const fields = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...fields].sort().flatMap((fieldPath) => display(before?.[fieldPath] ?? null) === display(after?.[fieldPath] ?? null)
    ? []
    : [{ fieldPath, oldValue: before?.[fieldPath] ?? null, newValue: after?.[fieldPath] ?? null }]);
}

function markIconSelected(value: any, candidateId: number) {
  const iconCandidates = (value?.iconCandidates || []).map((candidate: any) => ({
    ...candidate,
    selected: Number(candidate.id) === Number(candidateId),
    selectionOrigin: Number(candidate.id) === Number(candidateId) ? "manual" : null,
  }));
  return { ...value, iconCandidates, selectedIcon: iconCandidates.find((candidate: any) => candidate.selected) || value?.selectedIcon || null };
}

export function CatalogReviewWorkspace({ repository, onChanged, onContinueAutomation, focusObject = null }: { repository: any; onChanged: () => Promise<any>; onContinueAutomation?: () => void; focusObject?: { objectType: string; objectId: string } | null }) {
  const queue = repository?.reviewQueue || [];
  const laterQueue = repository?.laterQueue || [];
  const objects = repository?.objects || [];
  const ordinaryReviewEnabled = repository?.releaseControl?.entryMode !== "legacy-advanced";
  const [selectedKey, setSelectedKey] = useState<string | null>(() => {
    try { return globalThis.localStorage?.getItem(LOCAL_REVIEW_SELECTION_KEY) || null; }
    catch (_) { return null; }
  });
  const [skippedKeys, setSkippedKeys] = useState<string[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [objectDraft, setObjectDraft] = useState("{}");
  const [identityDraft, setIdentityDraft] = useState({ name: "", level: "", type: "" });
  const [relationDraft, setRelationDraft] = useState({ requiredCount: "2", mergeTarget: "" });
  const [actor, setActor] = useState("本地操作者");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [latestAuditSummary, setLatestAuditSummary] = useState<any>(null);
  const [pauseConfirmationOpen, setPauseConfirmationOpen] = useState(false);
  const [adoptedEvidencePayload, setAdoptedEvidencePayload] = useState<any>(null);
  const [pendingEvidenceRejection, setPendingEvidenceRejection] = useState<any>(null);
  const [advancedJsonEditing, setAdvancedJsonEditing] = useState(false);
  const [advancedJsonDraft, setAdvancedJsonDraft] = useState("{}");
  const [advancedJsonPreview, setAdvancedJsonPreview] = useState<any>(null);
  const [advancedJsonError, setAdvancedJsonError] = useState<{ fieldPath: string; message: string } | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [draftBaseRevision, setDraftBaseRevision] = useState<number | null>(null);
  const [recoverableDraft, setRecoverableDraft] = useState<any>(null);
  const [revisionConflict, setRevisionConflict] = useState<any>(null);
  const [pendingPostCommitRefresh, setPendingPostCommitRefresh] = useState<{
    committedReview: any;
    planningResult: any;
    planningRecovered: boolean;
  } | null>(null);
  const iconUploadRef = useRef<HTMLInputElement>(null);
  const detailRequestId = useRef(0);
  const completionRequest = useRef<{ key: string; requestId: string } | null>(null);
  const identityDraftKey = useRef<string | null>(null);
  const identityDraftDirty = useRef(false);
  const relationChainRef = useRef<HTMLDivElement>(null);
  const detailScrollRef = useRef<HTMLDivElement>(null);
  const draftDirtyRef = useRef(false);
  const draftObjectKeyRef = useRef<string | null>(null);

  const markDraftDirty = () => {
    if (!detail) return;
    draftDirtyRef.current = true;
    draftObjectKeyRef.current = `${detail.objectType}:${detail.objectId}`;
    setDraftDirty(true);
    setDraftBaseRevision((current) => current ?? Number(detail.revision));
  };

  const orderedQueue = useMemo(() => {
    const entriesByKey = new Map(queue.map((entry: any) => [`${entry.objectType}:${entry.objectId}`, entry]));
    const skipped = skippedKeys.flatMap((key) => entriesByKey.has(key) ? [entriesByKey.get(key)] : []);
    const skippedSet = new Set(skippedKeys);
    return [...queue.filter((entry: any) => !skippedSet.has(`${entry.objectType}:${entry.objectId}`)), ...skipped];
  }, [queue, skippedKeys]);

  const selectedSummary = useMemo(() => {
    const queuedKeys = new Set([...orderedQueue, ...laterQueue].map((item: any) => `${item.objectType}:${item.objectId}`));
    const candidates = [...orderedQueue, ...laterQueue, ...objects.filter((item: any) => !queuedKeys.has(`${item.objectType}:${item.objectId}`))];
    if (!selectedKey) return null;
    return candidates.find((item: any) => `${item.objectType}:${item.objectId}` === selectedKey) || null;
  }, [laterQueue, objects, orderedQueue, selectedKey]);

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
      const valueKey = `${value.objectType}:${value.objectId}`;
      const preserveLocalDraft = draftDirtyRef.current && draftObjectKeyRef.current === valueKey;
      if (preserveLocalDraft) return;
      const adoptedPayload = adoptedEvidencePayload?.objectKey === valueKey ? adoptedEvidencePayload.payload : null;
      setObjectDraft(JSON.stringify(adoptedPayload || value.candidateVersion?.payload || value.algorithmCandidate || value.effectiveValue || {}, null, 2));
      if (adoptedPayload || identityDraftKey.current !== valueKey || !identityDraftDirty.current) {
        setIdentityDraft(adoptedPayload ? identityDraftFromPayload(adoptedPayload) : identityDraftFromDetail(value));
        identityDraftDirty.current = false;
      }
      if (value.objectType === "merge-relation") setRelationDraft(adoptedPayload ? relationDraftFromPayload(adoptedPayload) : relationDraftFromDetail(value));
      identityDraftKey.current = valueKey;
      draftObjectKeyRef.current = valueKey;
      setDraftBaseRevision(Number(value.revision));
      setRecoverableDraft(readLocalReviewDraft(valueKey));
      setRevisionConflict(null);
    } catch (error: any) {
      if (requestId !== detailRequestId.current) return;
      setLoadError(`${error.message || "审核对象加载失败"}；已保留队列与选择，过期提交已禁用`);
    } finally {
      if (requestId === detailRequestId.current) setLoadingDetail(false);
    }
  };

  useEffect(() => { loadDetail(); }, [selectedSummary?.objectType, selectedSummary?.objectId, selectedSummary?.revision]);
  useEffect(() => { if (focusObject) setSelectedKey(`${focusObject.objectType}:${focusObject.objectId}`); }, [focusObject?.objectType, focusObject?.objectId]);
  useEffect(() => {
    try {
      if (selectedKey) globalThis.localStorage?.setItem(LOCAL_REVIEW_SELECTION_KEY, selectedKey);
      else globalThis.localStorage?.removeItem(LOCAL_REVIEW_SELECTION_KEY);
    } catch (_) {}
  }, [selectedKey]);
  useEffect(() => { setPauseConfirmationOpen(false); }, [detail?.objectType, detail?.objectId, detail?.revision]);
  useEffect(() => {
    draftDirtyRef.current = false;
    draftObjectKeyRef.current = selectedKey;
    setDraftDirty(false);
    setDraftBaseRevision(null);
    setRecoverableDraft(null);
    setRevisionConflict(null);
    setAdoptedEvidencePayload(null);
    setPendingEvidenceRejection(null);
    setAdvancedJsonEditing(false);
    setAdvancedJsonPreview(null);
    setAdvancedJsonError(null);
  }, [selectedKey]);

  const selectSummary = (entry: any) => {
    const key = `${entry.objectType}:${entry.objectId}`;
    setSkippedKeys((current) => current.filter((candidate) => candidate !== key));
    if (selectedKey === key) loadDetail(entry);
    else setSelectedKey(key);
  };

  const focusRelatedObject = (objectType: string, objectId: string) => {
    const entry = [...queue, ...laterQueue, ...objects]
      .find((candidate: any) => candidate.objectType === objectType && candidate.objectId === objectId);
    if (entry) selectSummary(entry);
    else setSelectedKey(`${objectType}:${objectId}`);
  };

  const fields = useMemo(() => Array.from(new Set([
    ...Object.keys(detail?.algorithmCandidate || {}),
    ...Object.keys(detail?.effectiveValue || {}),
    ...Object.keys(detail?.humanValues || {}),
  ])).sort(), [detail]);
  const visibleFields = useMemo(() => domainFields(detail), [detail]);
  const detailKey = detail ? `${detail.objectType}:${detail.objectId}` : "";
  const reviewCandidate = useMemo(
    () => adoptedEvidencePayload?.objectKey === detailKey
      ? structuredClone(adoptedEvidencePayload.payload)
      : reviewCandidateSnapshot(detail),
    [adoptedEvidencePayload, detail, detailKey],
  );
  const identitySnapshot = useMemo(
    () => itemIdentitySnapshot(reviewCandidate, identityDraft, detail?.selectedIcon),
    [detail?.selectedIcon, identityDraft, reviewCandidate],
  );
  const identityDifferences = useMemo(
    () => snapshotDifferences(reviewCandidate, identitySnapshot, ["name", "level", "type", "displayIcon"]),
    [identitySnapshot, reviewCandidate],
  );
  const identityDecision: "confirm" | "modify" = identityDifferences.length ? "modify" : "confirm";
  const identityLevelValid = identityDraft.level.trim() === "" || /^[1-9]\d*$/.test(identityDraft.level.trim());
  const relationItems = detail?.relationContext?.items || [];
  const relationSource = relationItems.find((item: any) => item.objectId === detail?.objectId) || null;
  const relationTarget = relationItems.find((item: any) => item.objectId === relationDraft.mergeTarget) || null;
  const waitingForMoreClues = waitingForMergeObservation(detail);
  const relationSnapshot = useMemo(() => ({
    ...structuredClone(reviewCandidate),
    itemId: detail?.objectId,
    requiredCount: Number(relationDraft.requiredCount),
    mergeTarget: relationDraft.mergeTarget || null,
  }), [detail?.objectId, relationDraft, reviewCandidate]);
  const relationDifferences = useMemo(
    () => snapshotDifferences(reviewCandidate, relationSnapshot, ["requiredCount", "mergeTarget"]),
    [relationSnapshot, reviewCandidate],
  );
  const relationError = detail?.objectType === "merge-relation" && !waitingForMoreClues
    ? relationValidationError(relationSource, relationTarget, relationDraft.requiredCount)
    : "";
  const relationDecision: "confirm" | "modify" = relationDifferences.length ? "modify" : "confirm";
  const localDraftSnapshot = useMemo(() => {
    if (advancedJsonEditing) {
      try { return parseObjectDraft(advancedJsonDraft); }
      catch (_) { return null; }
    }
    if (detail?.objectType === "item-identity") return identitySnapshot;
    if (detail?.objectType === "merge-relation") return relationSnapshot;
    return reviewCandidate;
  }, [advancedJsonDraft, advancedJsonEditing, detail?.objectType, identitySnapshot, relationSnapshot, reviewCandidate]);
  const visibleDifferences = useMemo(
    () => detail?.objectType === "item-identity"
      ? identityDifferences
      : detail?.objectType === "merge-relation"
        ? relationDifferences
        : meaningfulDifferences(detail, visibleFields),
    [detail, identityDifferences, relationDifferences, visibleFields],
  );
  useEffect(() => {
    if (!draftDirty || !detail || draftObjectKeyRef.current !== detailKey) return;
    writeLocalReviewDraft(detailKey, {
      objectType: detail.objectType,
      objectId: detail.objectId,
      baseRevision: draftBaseRevision ?? Number(detail.revision),
      snapshot: localDraftSnapshot,
      identityDraft,
      relationDraft,
      advancedJsonEditing,
      advancedJsonDraft,
      actor,
      note,
      scrollTop: detailScrollRef.current?.scrollTop || 0,
      savedAt: new Date().toISOString(),
    });
  }, [
    actor,
    advancedJsonDraft,
    advancedJsonEditing,
    detail,
    detailKey,
    draftBaseRevision,
    draftDirty,
    identityDraft,
    localDraftSnapshot,
    note,
    relationDraft,
  ]);
  const relationChainNodes = useMemo(() => {
    if (!relationSource?.chainId) return [];
    const members = relationItems
      .filter((item: any) => item.chainId === relationSource.chainId)
      .sort((left: any, right: any) => (left.level ?? Number.MAX_SAFE_INTEGER) - (right.level ?? Number.MAX_SAFE_INTEGER)
        || left.name.localeCompare(right.name));
    const knownLevels = members.map((item: any) => item.level).filter((level: any) => Number.isInteger(level));
    const unknownLevelMembers = members
      .filter((item: any) => !Number.isInteger(item.level))
      .map((item: any) => ({ ...item, unknownLevel: true }));
    if (!knownLevels.length) return unknownLevelMembers;
    const byLevel = new Map(members.filter((item: any) => item.level != null).map((item: any) => [item.level, item]));
    const nodes = [];
    for (let level = Math.min(...knownLevels); level <= Math.max(...knownLevels); level += 1) {
      nodes.push(byLevel.get(level) || { objectId: `missing-level-${level}`, name: "未命名物品", level, chainId: relationSource.chainId, placeholder: true });
    }
    return [...nodes, ...unknownLevelMembers];
  }, [relationItems, relationSource]);

  const restoreLocalDraft = () => {
    if (!detail || !recoverableDraft) return;
    if (recoverableDraft.identityDraft) setIdentityDraft(recoverableDraft.identityDraft);
    if (recoverableDraft.relationDraft) setRelationDraft(recoverableDraft.relationDraft);
    setAdvancedJsonEditing(!!recoverableDraft.advancedJsonEditing);
    if (recoverableDraft.advancedJsonDraft) setAdvancedJsonDraft(recoverableDraft.advancedJsonDraft);
    if (recoverableDraft.actor) setActor(recoverableDraft.actor);
    setNote(recoverableDraft.note || "");
    identityDraftDirty.current = true;
    draftDirtyRef.current = true;
    draftObjectKeyRef.current = detailKey;
    setDraftDirty(true);
    setDraftBaseRevision(Number(recoverableDraft.baseRevision));
    if (Number(recoverableDraft.baseRevision) !== Number(detail.revision)) {
      const latestSnapshot = detail.effectiveValue || detail.algorithmCandidate || {};
      setRevisionConflict({
        localBaseRevision: Number(recoverableDraft.baseRevision),
        currentRevision: Number(detail.revision),
        meaningfulDifferences: localDraftDifferences(latestSnapshot, recoverableDraft.snapshot || {}),
      });
    }
    const scrollTop = Number(recoverableDraft.scrollTop) || 0;
    globalThis.requestAnimationFrame?.(() => {
      if (detailScrollRef.current) detailScrollRef.current.scrollTop = scrollTop;
    });
    setRecoverableDraft(null);
    setMessage("已恢复本地未提交草稿；请基于运行时最新对象重新核对后提交。");
  };

  const discardLocalDraft = () => {
    if (!detail) return;
    removeLocalReviewDraft(detailKey);
    const candidate = reviewCandidateSnapshot(detail);
    setObjectDraft(JSON.stringify(candidate, null, 2));
    setIdentityDraft(identityDraftFromDetail(detail));
    if (detail.objectType === "merge-relation") setRelationDraft(relationDraftFromDetail(detail));
    setAdvancedJsonEditing(false);
    setAdvancedJsonDraft(JSON.stringify(candidate, null, 2));
    setAdvancedJsonPreview(null);
    setAdvancedJsonError(null);
    identityDraftDirty.current = false;
    draftDirtyRef.current = false;
    setDraftDirty(false);
    setDraftBaseRevision(Number(detail.revision));
    setRecoverableDraft(null);
    setRevisionConflict(null);
    setMessage("已放弃本地草稿，继续使用 Automation Runtime 的最新对象。");
  };

  const finishPostCommitRefresh = (refreshedCatalog: any, committedReview: any, planningResult: any, planningRecovered: boolean) => {
    const refreshedQueue = refreshedCatalog?.repository?.reviewQueue || queue;
    const refreshedEntriesByKey = new Map(refreshedQueue.map((entry: any) => [`${entry.objectType}:${entry.objectId}`, entry]));
    const refreshedSkipped = skippedKeys.flatMap((key) => refreshedEntriesByKey.has(key) ? [refreshedEntriesByKey.get(key)] : []);
    const refreshedSkippedSet = new Set(skippedKeys);
    const refreshedOrderedQueue = [
      ...refreshedQueue.filter((entry: any) => !refreshedSkippedSet.has(`${entry.objectType}:${entry.objectId}`)),
      ...refreshedSkipped,
    ];
    setSkippedKeys((current) => current.filter((key) => refreshedEntriesByKey.has(key)));
    const currentKey = `${committedReview.objectType}:${committedReview.objectId}`;
    const blockingTarget = planningResult.blockingReviewTarget;
    const relatedEntry = !planningRecovered && blockingTarget
      ? refreshedQueue.find((entry: any) => entry.objectType === blockingTarget.objectType && entry.objectId === blockingTarget.objectId)
      : null;
    const nextEntry = refreshedOrderedQueue.find((entry: any) => `${entry.objectType}:${entry.objectId}` !== currentKey);
    const nextReviewKey = relatedEntry && `${relatedEntry.objectType}:${relatedEntry.objectId}` !== currentKey
      ? `${relatedEntry.objectType}:${relatedEntry.objectId}`
      : committedReview.reviewStatus === "needs-review" || !planningRecovered
        ? currentKey
        : nextEntry ? `${nextEntry.objectType}:${nextEntry.objectId}` : null;
    setPendingPostCommitRefresh(null);
    setMessage(planningRecovered
      ? "审核结论已保存，规划已经恢复"
      : relatedEntry && nextReviewKey !== currentKey
        ? `裁决已保存、规划尚未恢复：阻塞已转移到关联对象“${relatedEntry.displayTitle || "未命名物品"}”，正在切换到该对象独立审核。`
        : `裁决已保存、规划尚未恢复：${planningBoundaryText(planningResult.boundaryReason)}；已保留当前诊断上下文。`);
    setSelectedKey(nextReviewKey);
    if (nextReviewKey !== currentKey) setDetail(null);
  };

  const postCommitRefreshFailureMessage = (planningResult: any, planningRecovered: boolean, error: any) => {
    const savedState = planningRecovered
      ? "审核结论已保存，规划已经恢复"
      : `裁决已保存、规划尚未恢复：${planningBoundaryText(planningResult.boundaryReason)}`;
    return `${savedState}；工作台刷新失败：${error?.message || "暂时无法读取最新队列"}。已禁用过期提交，请重试刷新。`;
  };

  const retryPostCommitRefresh = async () => {
    if (!pendingPostCommitRefresh) return;
    setBusy(true);
    try {
      const refreshedCatalog = await onChanged();
      finishPostCommitRefresh(
        refreshedCatalog,
        pendingPostCommitRefresh.committedReview,
        pendingPostCommitRefresh.planningResult,
        pendingPostCommitRefresh.planningRecovered,
      );
    } catch (error: any) {
      setMessage(postCommitRefreshFailureMessage(
        pendingPostCommitRefresh.planningResult,
        pendingPostCommitRefresh.planningRecovered,
        error,
      ));
    } finally {
      setBusy(false);
    }
  };

  const skipCurrentReview = () => {
    if (!detail || orderedQueue.length === 0) return;
    const currentKey = `${detail.objectType}:${detail.objectId}`;
    const currentIndex = orderedQueue.findIndex((entry: any) => `${entry.objectType}:${entry.objectId}` === currentKey);
    if (currentIndex < 0) return;
    const nextEntry = orderedQueue.length > 1 ? orderedQueue[(currentIndex + 1) % orderedQueue.length] : null;
    setSkippedKeys((current) => [...current.filter((key) => key !== currentKey), currentKey]);
    setMessage("已暂时跳过，本轮稍后再处理；对象事实与规划资格均未改变。");
    if (nextEntry) {
      setSelectedKey(`${nextEntry.objectType}:${nextEntry.objectId}`);
      setDetail(null);
    }
  };

  const completeReview = async (decision: "confirm" | "modify", snapshotOverride: any = null) => {
    if (pendingPostCommitRefresh) {
      setMessage("审核结论已经保存；请先重试刷新工作台，再提交新的完整快照。");
      return;
    }
    if (!detail || !actor.trim()) { setMessage("请填写操作者"); return; }
    if (detail.objectType === "item-identity" && !identityLevelValid) {
      setMessage("等级必须是正整数或留空表示未知");
      return;
    }
    if (detail.objectType === "merge-relation" && relationError) {
      setMessage(relationError);
      return;
    }
    const failureScrollTop = detailScrollRef.current?.scrollTop || 0;
    setBusy(true);
    try {
      const effectiveDecision = snapshotOverride
        ? "modify"
        : detail.objectType === "item-identity"
          ? identityDecision
          : detail.objectType === "merge-relation" ? relationDecision : decision;
      const snapshot = snapshotOverride || (detail.objectType === "item-identity"
        ? identitySnapshot
        : detail.objectType === "merge-relation"
          ? relationSnapshot
          : effectiveDecision === "confirm" ? structuredClone(reviewCandidate) : parseObjectDraft(objectDraft));
      const requestKey = `${detail.objectType}:${detail.objectId}:${detail.revision}:${effectiveDecision}:${JSON.stringify(snapshot)}`;
      if (completionRequest.current?.key !== requestKey) {
        completionRequest.current = {
          key: requestKey,
          requestId: globalThis.crypto?.randomUUID?.() || `catalog-review-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        };
      }
      const committedReview = await controlApi.completeCatalogReview({
        objectType: detail.objectType, objectId: detail.objectId, decision: effectiveDecision,
        snapshot, actor: actor.trim(), ...(note.trim() ? { note: note.trim() } : {}),
        requestId: completionRequest.current.requestId,
        expectedRevision: detail.revision,
      });
      setDetail(committedReview);
      setLatestAuditSummary(committedReview.catalogAuditSummary || null);
      setAdoptedEvidencePayload(null);
      removeLocalReviewDraft(detailKey);
      draftDirtyRef.current = false;
      setDraftDirty(false);
      setDraftBaseRevision(Number(committedReview.revision));
      setRecoverableDraft(null);
      setRevisionConflict(null);
      setAdvancedJsonEditing(false);
      setAdvancedJsonPreview(null);
      setAdvancedJsonError(null);
      setObjectDraft(JSON.stringify(committedReview.candidateVersion?.payload || committedReview.algorithmCandidate || committedReview.effectiveValue || {}, null, 2));
      setIdentityDraft(identityDraftFromDetail(committedReview));
      if (committedReview.objectType === "merge-relation") setRelationDraft(relationDraftFromDetail(committedReview));
      identityDraftKey.current = `${committedReview.objectType}:${committedReview.objectId}`;
      identityDraftDirty.current = false;
      setNote("");
      completionRequest.current = null;
      const planningResult = committedReview.reviewResolution?.planningResult || {};
      const planningRecovered = planningResult.recovered === true;
      try {
        const refreshedCatalog = await onChanged();
        finishPostCommitRefresh(refreshedCatalog, committedReview, planningResult, planningRecovered);
      } catch (refreshError: any) {
        setPendingPostCommitRefresh({ committedReview, planningResult, planningRecovered });
        setMessage(postCommitRefreshFailureMessage(planningResult, planningRecovered, refreshError));
      }
    } catch (error: any) {
      if (error.payload?.code === "CATALOG_REVISION_CONFLICT" && error.payload?.currentObject) {
        const currentObject = error.payload.currentObject;
        setDetail(currentObject);
        draftDirtyRef.current = true;
        draftObjectKeyRef.current = `${currentObject.objectType}:${currentObject.objectId}`;
        setDraftDirty(true);
        setRevisionConflict({
          localBaseRevision: draftBaseRevision ?? Number(detail.revision),
          currentRevision: Number(currentObject.revision),
          meaningfulDifferences: error.payload.meaningfulDifferences || [],
        });
        await onChanged().catch(() => null);
        setMessage("revision 冲突：已加载最新对象并保留当前对象、草稿与滚动位置；请查看有意义差异后重新确认。");
      } else if (error.payload?.currentObject) {
        setDetail(error.payload.currentObject);
        setObjectDraft(JSON.stringify(error.payload.currentObject.algorithmCandidate || error.payload.currentObject.effectiveValue || {}, null, 2));
        setIdentityDraft(identityDraftFromDetail(error.payload.currentObject));
        if (error.payload.currentObject.objectType === "merge-relation") setRelationDraft(relationDraftFromDetail(error.payload.currentObject));
        identityDraftKey.current = `${error.payload.currentObject.objectType}:${error.payload.currentObject.objectId}`;
        identityDraftDirty.current = false;
        setMessage(error.message);
      } else {
        setMessage(`${error.message}；已保留当前对象、草稿与滚动位置，生效快照未改变。`);
      }
      globalThis.requestAnimationFrame?.(() => {
        if (detailScrollRef.current) detailScrollRef.current.scrollTop = failureScrollTop;
      });
    } finally { setBusy(false); }
  };

  const setEvidenceDisposition = async (evidenceId: number, disposition: "eligible" | "paused" | "rejected", action?: string) => {
    if (!detail || !note.trim() || !actor.trim()) { setMessage("处置证据前请填写操作者和审核备注"); return null; }
    const updated = await controlApi.setCatalogEvidenceDisposition({
      objectType: detail.objectType, objectId: detail.objectId, evidenceId, disposition,
      reason: `${actor.trim()}: ${note.trim()}`, actor: actor.trim(), note: note.trim(), action, expectedRevision: detail.revision,
    });
    setDetail(updated);
    setObjectDraft(JSON.stringify(updated.effectiveValue || updated.algorithmCandidate || {}, null, 2));
    setLatestAuditSummary(updated.catalogAuditSummary || null);
    return updated;
  };

  const updateEvidenceDisposition = async (evidenceId: number, disposition: "eligible" | "paused" | "rejected") => {
    if (disposition === "rejected" && Number(pendingEvidenceRejection?.id) !== Number(evidenceId)) {
      if (!note.trim() || !actor.trim()) { setMessage("否决证据前请填写操作者和审核备注"); return; }
      setPendingEvidenceRejection(detail?.evidence?.find((evidence: any) => Number(evidence.id) === Number(evidenceId)) || null);
      setMessage("");
      return;
    }
    setBusy(true);
    try {
      const action = disposition === "rejected" ? "reject-evidence" : disposition === "paused" ? "pause-evidence" : "restore-evidence";
      const updated = await setEvidenceDisposition(evidenceId, disposition, action);
      if (!updated) return;
      setPendingEvidenceRejection(null);
      setNote("");
      setMessage(disposition === "eligible" ? "证据已恢复并重新评估" : disposition === "paused" ? "证据已暂停并重新评估" : "证据已否决并从后续自动推断及规划融合中排除");
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
      const selected = detail.evidence?.find((evidence: any) => Number(evidence.id) === Number(evidenceId));
      if (!selected) throw new Error("证据不存在或已刷新");
      const updated = await setEvidenceDisposition(evidenceId, "eligible", "accept-evidence");
      if (!updated) return;
      setAdoptedEvidencePayload({
        objectKey: `${updated.objectType}:${updated.objectId}`,
        evidenceId,
        payload: structuredClone(selected.payload),
      });
      markDraftDirty();
      setDetail(updated);
      setLatestAuditSummary(updated.catalogAuditSummary || null);
      setObjectDraft(JSON.stringify(selected.payload, null, 2));
      if (updated.objectType === "item-identity") {
        setIdentityDraft(identityDraftFromPayload(selected.payload));
        identityDraftDirty.current = true;
      }
      if (updated.objectType === "merge-relation") setRelationDraft(relationDraftFromPayload(selected.payload));
      setNote("");
      setMessage("已采用该证据并带入领域表单；仍需确认完整对象快照，不会隐式确认关联对象");
      await onChanged();
    } catch (error: any) {
      if (error.payload?.currentObject) setDetail(error.payload.currentObject);
      setMessage(error.message);
    } finally { setBusy(false); }
  };

  const togglePause = async () => {
    if (!detail) return;
    if (detail.disposition !== "paused" && !pauseConfirmationOpen) {
      setPauseConfirmationOpen(true);
      setMessage("");
      return;
    }
    setBusy(true);
    try {
      const disposition = detail.disposition === "paused" ? "enabled" : "paused";
      const updated = await controlApi.setCatalogObjectDisposition({ objectType: detail.objectType, objectId: detail.objectId, disposition, reason: disposition === "paused" ? "operator-paused-review" : "operator-resumed-review", expectedRevision: detail.revision });
      setDetail(updated);
      setPauseConfirmationOpen(false);
      setMessage(disposition === "paused"
        ? "对象已暂停并立即退出真实规划"
        : updated.planningEligible ? "对象已恢复并重新参与规划" : "对象已恢复，当前状态仍未取得规划资格");
      await onChanged();
    } catch (error: any) {
      if (error.payload?.currentObject) setDetail(error.payload.currentObject);
      setPauseConfirmationOpen(false);
      setMessage(error.payload?.code === "CATALOG_REVISION_CONFLICT" ? "对象已被其他控制台修改；已加载最新版本，请重新预览影响" : error.message);
    } finally { setBusy(false); }
  };

  const beginAdvancedJsonEdit = () => {
    setAdvancedJsonDraft(objectDraft);
    setAdvancedJsonEditing(true);
    setAdvancedJsonPreview(null);
    setAdvancedJsonError(null);
    setMessage("已进入高级 JSON 编辑；该草稿与领域表单分离，校验前不会改变对象。");
  };

  const previewAdvancedJsonSnapshot = async () => {
    if (!detail) return;
    let snapshot;
    try {
      snapshot = parseObjectDraft(advancedJsonDraft);
    } catch (error: any) {
      setAdvancedJsonPreview(null);
      setAdvancedJsonError({
        fieldPath: "JSON",
        message: `JSON 语法或结构错误：${error.message}；已保留当前 JSON 草稿。`,
      });
      return;
    }
    setBusy(true);
    try {
      const preview = await controlApi.previewCatalogReview({
        objectType: detail.objectType,
        objectId: detail.objectId,
        snapshot,
        expectedRevision: detail.revision,
      });
      setAdvancedJsonPreview(preview);
      setAdvancedJsonError(null);
      setMessage("快照校验通过；请核对人话差异和影响范围后再次确认。");
    } catch (error: any) {
      setAdvancedJsonPreview(null);
      setAdvancedJsonError({
        fieldPath: error.payload?.fieldPath || "snapshot",
        message: `${error.message}；已保留当前 JSON 草稿。`,
      });
    } finally {
      setBusy(false);
    }
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
        <div className="review-queue-list">{orderedQueue.length ? orderedQueue.map((entry: any) => {
          const entryKey = `${entry.objectType}:${entry.objectId}`;
          return <button key={entryKey} className={`${selectedKey === entryKey ? "active" : ""}`} onClick={() => selectSummary(entry)}>
          <span><strong>{entry.displayTitle || "未命名物品"}</strong><small>{valueLabel(entry.objectType)} · {skippedKeys.includes(entryKey) ? "已跳过" : entry.actionStatus || "需要处理"}</small></span>
          <span className="reason-chips">{entry.reasons.map((reason: any, index: number) => <i className={reason.type} key={`${reason.type}-${index}`}>{reviewReasonMetadata[reason.type]?.label || reason.type}</i>)}</span>
        </button>;
        }) : <div className="empty-state compact"><Check/><span>当前没有待裁定对象</span></div>}</div>
        <details className="later-review-queue">
          <summary><span>以后再看</span><b>{laterQueue.length}</b></summary>
          <p>这里只收纳不影响当前规划的完整性缺口。</p>
          <div className="review-queue-list">{laterQueue.length ? laterQueue.map((entry: any) => <button key={`${entry.objectType}:${entry.objectId}`} className={`${selectedKey === `${entry.objectType}:${entry.objectId}` ? "active" : ""}`} onClick={() => selectSummary(entry)}>
            <span><strong>{entry.displayTitle || "未命名物品"}</strong><small>{valueLabel(entry.objectType)} · {entry.actionStatus}</small></span>
            <span className="reason-chips">{entry.gaps.map((gap: any, index: number) => <i className={gap.type} key={`${gap.type}-${index}`}>{reviewReasonMetadata[gap.type]?.label || gap.type}</i>)}</span>
          </button>) : <div className="empty-state compact"><Check/><span>当前没有待补对象</span></div>}</div>
        </details>
      </div>
      <div className="panel review-detail" ref={detailScrollRef}>
        {latestAuditSummary && <div className="catalog-audit-summary latest-audit-receipt"><strong>Catalog Audit Summary</strong><span>{catalogAuditSummarySentence(latestAuditSummary)}</span></div>}
        {loadingDetail ? <div className="empty-state"><History className="spin"/><strong>正在加载审核对象…</strong><span>正在读取证据、版本和裁决记录</span></div> : !detail ? <div className="empty-state"><History/><strong>{loadError ? "审核对象加载失败" : "从审核队列选择对象"}</strong>{loadError && <><span>{loadError}</span><button className="ghost-btn" onClick={() => loadDetail()}>重试</button></>}</div> : <>
          <div className="panel-head">
            <div><span className="eyebrow">对象详情</span><h2>{catalogObjectTitle(detail, selectedSummary)}</h2><small>{valueLabel(detail.objectType)} · {selectedSummary?.actionStatus || (detail.reviewStatus === "needs-review" ? "需要处理" : "已确认")}</small></div>
            <div className="review-head-actions">{detail.objectType === "item-identity" && <button className="ghost-btn" disabled={busy} onClick={acquireIcon}><Image size={15}/>采集真实图标</button>}{detail.disposition === "paused" ? <button className="ghost-btn" disabled={busy} onClick={togglePause}><Play size={15}/>恢复对象</button> : <span className="object-disposition-badge">规划中</span>}</div>
          </div>
          {(message || pendingPostCommitRefresh) && <p className="review-message" role="status">{message || "审核结论已经保存；工作台队列仍需刷新。"}{pendingPostCommitRefresh && <button className="ghost-btn" disabled={busy} onClick={retryPostCommitRefresh}>重试刷新工作台</button>}</p>}
          {recoverableDraft && <div className="local-draft-recovery" role="alertdialog" aria-label="恢复本地审核草稿">
            <div><strong>发现本地未提交草稿</strong><p>草稿基于 revision {recoverableDraft.baseRevision}，最新对象 revision {detail.revision}。系统没有自动套用，请明确恢复或放弃。</p></div>
            <div><button onClick={restoreLocalDraft}>恢复本地草稿</button><button className="ghost-btn" onClick={discardLocalDraft}>放弃本地草稿</button></div>
          </div>}
          {revisionConflict && <div className="revision-conflict-review" role="alertdialog" aria-label="重新确认 revision 冲突">
            <div><strong>最新对象与本地草稿需要重新确认</strong><p>草稿基于 revision {revisionConflict.localBaseRevision}；最新对象 revision {revisionConflict.currentRevision}。</p></div>
            <section>{revisionConflict.meaningfulDifferences?.length
              ? revisionConflict.meaningfulDifferences.map((difference: any) => <span key={difference.fieldPath}><b>{fieldLabel(difference.fieldPath)}</b>{display(difference.oldValue)} → {display(difference.newValue)}</span>)
              : <span>没有领域字段差异，但对象 revision 已更新。</span>}</section>
            <div><button onClick={() => { setRevisionConflict(null); setMessage("已确认以最新对象为基线；本地草稿仍保留，请再次提交。"); }}>按最新版本重新确认</button><button className="ghost-btn" onClick={discardLocalDraft}>放弃本地草稿</button></div>
          </div>}
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
          {detail.objectType === "merge-relation" && <section className="merge-relation-review">
            <div className="relation-review-head"><div><span className="eyebrow">关系上下文</span><h3>合成关系独立审核</h3></div><strong>独立审核</strong></div>
            <p className="independent-review-note">切换关系只改变审核焦点；每个对象都需要独立审核。</p>
            <p className="catalog-relationship-sentence">由 <button aria-label={`关系句来源物 ${relationItemLabel(relationSource)}`} onClick={() => relationSource && focusRelatedObject("item-identity", relationObjectKey(relationSource))}>{relationItemLabel(relationSource)}</button> × {relationDraft.requiredCount || "未知"} 合成为 <button aria-label={`关系句结果物 ${relationItemLabel(relationTarget)}`} disabled={!relationTarget} onClick={() => relationTarget && focusRelatedObject("item-identity", relationObjectKey(relationTarget))}>{relationItemLabel(relationTarget)}</button></p>
            <div className="merge-relation-form">
              <button className="relation-source-choice" aria-label={`来源物 ${relationItemLabel(relationSource)}`} onClick={() => relationSource && focusRelatedObject("item-identity", relationObjectKey(relationSource))}>{relationSource?.iconUrl ? <img src={relationSource.iconUrl} alt=""/> : <Image/>}<span><small>来源物</small><strong>{relationItemLabel(relationSource)}</strong></span></button>
              <label><span>所需数量</span><input aria-label="所需数量" type="number" min="2" max="2" step="1" value={relationDraft.requiredCount} onChange={(event) => { markDraftDirty(); setRelationDraft((current) => ({ ...current, requiredCount: event.target.value })); }}/><small>同级物品固定为 2 个</small></label>
              {waitingForMoreClues
                ? <label><span>结果物</span><input aria-label="结果物" value="等待真实观测" readOnly/><small>结果尚未真实出现，等待正常订单推进产生可归因观测。</small></label>
                : <div className="relation-target-choices"><span>结果物</span><div>{relationItems.map((item: any) => <button key={relationObjectKey(item)} className={relationObjectKey(item) === relationDraft.mergeTarget ? "selected" : ""} aria-label={`选择结果物 ${relationItemLabel(item)}`} onClick={() => { markDraftDirty(); setRelationDraft((current) => ({ ...current, mergeTarget: relationObjectKey(item) })); setMessage(""); }}>{item.iconUrl ? <img src={item.iconUrl} alt=""/> : <Image/>}<strong>{item.name}</strong><small>{item.level == null ? "等级未知" : `第 ${item.level} 级`}</small></button>)}</div></div>}
            </div>
            {relationError && <p className="relation-validation-error" role="alert"><AlertTriangle size={15}/>{relationError}</p>}
            <div className="relation-chain-head"><div><strong>完整合成链</strong><span>当前焦点高亮；虚线节点表示未知等级或断点。</span></div><div><button aria-label="合成链向左浏览" onClick={() => relationChainRef.current?.scrollBy({ left: -280, behavior: "smooth" })}><ChevronLeft size={16}/></button><button aria-label="合成链向右浏览" onClick={() => relationChainRef.current?.scrollBy({ left: 280, behavior: "smooth" })}><ChevronRight size={16}/></button></div></div>
            <div className="relation-chain-track" role="region" aria-label="完整横向合成链" ref={relationChainRef}>{relationChainNodes.map((node: any, index: number) => {
              const next = relationChainNodes[index + 1];
              const relation = (detail.relationContext?.relations || []).find((entry: any) => entry.itemId === relationObjectKey(node));
              const broken = !!next && (node.placeholder || node.unknownLevel || next.placeholder || next.unknownLevel
                || !relation || relation.mergeTarget !== relationObjectKey(next));
              const isCurrent = relationObjectKey(node) === relationObjectKey(detail);
              return <div className="relation-chain-node-wrap" key={relationObjectKey(node)}>
                <button className={`relation-chain-node ${node.placeholder || node.unknownLevel ? "placeholder" : ""} ${isCurrent ? "current" : ""}`} aria-label={`${isCurrent ? "当前焦点 " : ""}${relationItemLabel(node)}`} disabled={node.placeholder} onClick={() => !node.placeholder && focusRelatedObject((detail.relationContext?.relations || []).some((entry: any) => relationObjectKey(entry) === relationObjectKey(node)) ? "merge-relation" : "item-identity", relationObjectKey(node))}>{node.iconUrl ? <img src={node.iconUrl} alt=""/> : <Image/>}<strong>{node.placeholder ? `未命名物品（第 ${node.level} 级）` : node.name}</strong><small>{node.level == null ? "等级未知" : `第 ${node.level} 级`}</small>{isCurrent && <i>当前焦点</i>}</button>
                {next && <span className={broken ? "breakpoint" : ""} aria-label={broken ? `断点：${relationItemLabel(node)}到${relationItemLabel(next)}` : `${relationItemLabel(node)}合成为${relationItemLabel(next)}`}>{broken ? "链条断点" : "×2 →"}</span>}
              </div>;
            })}</div>
          </section>}
          {detail.objectType === "production-profile" && <section className="production-profile-review" role="region" aria-label="产出档案内容">
            <div className="production-profile-head"><div><span className="eyebrow">关系上下文</span><h3>产出档案</h3></div><strong>集合由真实动作自动维护</strong></div>
            <p className="independent-review-note">档案只说明所属产出物、候选产物和可用档位；每个产出档位独立裁决体力与产物分布。</p>
            <div className="production-profile-groups">
              <div><span>所属产出物</span><button className="production-profile-item producer" onClick={() => detail.productionProfileContext?.producer && focusRelatedObject("item-identity", detail.productionProfileContext.producer.itemKey)}>{detail.productionProfileContext?.producer?.iconUrl ? <img src={detail.productionProfileContext.producer.iconUrl} alt=""/> : <Image/>}<strong>{productionProfileItemLabel(detail.productionProfileContext?.producer)}</strong></button></div>
              <div><span>候选产物集合</span><div className="production-profile-items">{detail.productionProfileContext?.candidateOutputs?.length ? detail.productionProfileContext.candidateOutputs.map((item: any) => <button className="production-profile-item" key={item.itemKey} onClick={() => focusRelatedObject("item-identity", item.itemKey)}>{item.iconUrl ? <img src={item.iconUrl} alt=""/> : <Image/>}<strong>{productionProfileItemLabel(item)}</strong></button>) : <p>尚未取得可归因的真实产物。</p>}</div></div>
              <div><span>可用产出档位</span><div className="production-profile-modes">{detail.productionProfileContext?.productionModes?.length ? detail.productionProfileContext.productionModes.map((mode: any) => <button key={mode.modeId} onClick={() => focusRelatedObject("production-mode", mode.modeKey)}><strong>{mode.modeId}</strong><small>{mode.unlocked ? "可用" : "未解锁"} · {valueLabel(mode.status)}</small></button>) : <p>尚未观测到可用产出档位。</p>}</div></div>
            </div>
          </section>}
          {detail.objectType === "production-mode" && <section className="production-mode-review" role="region" aria-label="产出档位分布">
            <div className="production-mode-head"><div><span className="eyebrow">档位知识</span><h3>产出档位</h3></div><strong>系统融合，普通审核只读</strong></div>
            <p className="independent-review-note">单次体力 {Number.isFinite(detail.productionModeContext?.energyCost) ? detail.productionModeContext.energyCost : "未知"} · 档位 {detail.productionModeContext?.modeId || "未知"}；理论配置不计入真实样本，未解决来源或归因的动作不会进入规划分布。</p>
            {detail.productionModeContext?.distribution ? <div className="production-distribution-grid">
              <article>
                <h4>理论产出分布</h4>
                <p className="distribution-source">配置 {detail.productionModeContext.distribution.theoreticalDistribution.configVersion} · 来源 {detail.productionModeContext.distribution.theoreticalDistribution.extractionSource}</p>
                <div className="distribution-outcomes">{detail.productionModeContext.distribution.theoreticalDistribution.outcomes.map((outcome: any) => <p key={outcome.itemId}><strong>{productionDistributionItemLabel(detail.productionModeContext, outcome.itemId)}</strong><span>权重 {outcome.weight} · {percentage(outcome.probability)}</span></p>)}</div>
              </article>
              <article>
                <h4>真实观测分布</h4>
                <p className="distribution-source">样本量 {detail.productionModeContext.distribution.observedDistribution.sampleSize} 次动作 · 实见产物 {detail.productionModeContext.distribution.observedDistribution.totalOutcomeCount} 个</p>
                <div className="distribution-outcomes">{detail.productionModeContext.distribution.observedDistribution.outcomes.length ? detail.productionModeContext.distribution.observedDistribution.outcomes.map((outcome: any) => <p key={outcome.itemId}><strong>{productionDistributionItemLabel(detail.productionModeContext, outcome.itemId)} · {outcome.count} 个</strong><span>{percentage(outcome.probability)}</span></p>) : <p><span>尚无可归因的真实产出样本</span></p>}</div>
                {detail.productionModeContext.distribution.planningDistribution.stability === "low-sample" && <p className="distribution-stability low">低样本：仍在积累，达到 {detail.productionModeContext.distribution.planningDistribution.rules.minimumReliableActions} 次动作前保留更高不确定性。</p>}
              </article>
              <article>
                <h4>规划采用分布</h4>
                <p className="distribution-source">{planningBasisLabel(detail.productionModeContext.distribution.planningDistribution.basis)} · {valueLabel(detail.productionModeContext.executionMode)}模式</p>
                <div className="distribution-outcomes">{detail.productionModeContext.distribution.planningDistribution.outcomes.map((outcome: any) => <p key={outcome.itemId}><strong>{productionDistributionItemLabel(detail.productionModeContext, outcome.itemId)}</strong><span>采用 {percentage(outcome.probability)} · 期望 {percentage(outcome.expectedProbability)}</span></p>)}</div>
                <p className="distribution-stability">未见产物余量 {percentage(detail.productionModeContext.distribution.planningDistribution.uncertaintyMass)} · 自动模式按 95% 置信下界保守规划。</p>
              </article>
            </div> : <div className="empty-state compact"><History/><span>尚未取得带来源的理论配置，真实样本会暂存并在配置出现后重放。</span></div>}
          </section>}
          {ordinaryReviewEnabled ? <>
          <div className="candidate-snapshot">
            <h3>本次将确认的完整候选</h3>
            {detail.objectType === "item-identity" ? <div className="item-identity-form">
              <label><span>名称</span><input aria-label="名称" value={identityDraft.name} onChange={(event) => { identityDraftDirty.current = true; markDraftDirty(); setIdentityDraft((current) => ({ ...current, name: event.target.value })); }} placeholder="留空表示未知"/></label>
              <label><span>等级</span><input aria-label="等级" inputMode="numeric" value={identityDraft.level} onChange={(event) => { identityDraftDirty.current = true; markDraftDirty(); setIdentityDraft((current) => ({ ...current, level: event.target.value })); }} placeholder="留空表示未知"/></label>
              <label><span>类型</span><input aria-label="类型" value={identityDraft.type} onChange={(event) => { identityDraftDirty.current = true; markDraftDirty(); setIdentityDraft((current) => ({ ...current, type: event.target.value })); }} placeholder="留空表示未知"/></label>
              <div className="identity-icon-field"><span>展示图标</span><strong>{detail.selectedIcon ? `候选 ${detail.iconCandidates.findIndex((candidate: any) => candidate.id === detail.selectedIcon.id) + 1}` : "未知"}</strong><small>在上方真实图标候选中选择</small></div>
              {!identityLevelValid && <p className="identity-validation" role="alert">等级必须是正整数或留空表示未知</p>}
            </div> : detail.objectType === "merge-relation" ? <p className="relation-snapshot-note">{relationItemLabel(relationSource)} × {relationDraft.requiredCount || "未知"} → {relationItemLabel(relationTarget)}</p> : <div className="candidate-facts">{visibleFields.length ? visibleFields.map((field) => <div key={field}><span>{fieldLabel(field)}</span><strong>{display(reviewCandidate[field])}</strong></div>) : <p>当前候选没有需要操作者核对的领域字段。</p>}</div>}
          </div>
          <div className="meaningful-differences">
            <h3>有意义的差异</h3>
            {visibleDifferences.length ? visibleDifferences.map((difference) => <p key={difference.field}><strong>{fieldLabel(difference.field)}</strong><span>{detail.objectType === "merge-relation" && difference.field === "mergeTarget" ? `${relationItemLabel(relationItems.find((item: any) => relationObjectKey(item) === difference.oldValue))} → ${relationItemLabel(relationItems.find((item: any) => relationObjectKey(item) === difference.newValue))}` : `${display(difference.oldValue)} → ${display(difference.newValue)}`}</span></p>) : <p>{detail.objectType === "item-identity" ? "身份字段与候选一致；未知值会原样保留。" : detail.objectType === "merge-relation" ? "合成关系与当前候选一致。" : "候选与当前生效的领域信息一致；本次只需确认语义审核原因。"}</p>}
          </div>
          {selectedSummary?.actionStatus !== "以后再看" && (waitingForMoreClues
            ? <div className="waiting-review-state" role="status"><strong>等待更多线索</strong><p>结果尚未真实出现，普通审核动作暂时隐藏。返回自动化后，由正常订单推进继续收集。</p><button className="primary-action" onClick={onContinueAutomation}>返回自动化继续收集</button></div>
            : <div className="ruling-editor object-review-editor">
            <div className="wide review-resolution-help"><h3>完整对象审核</h3><p>“确认无误”会一次提交完整候选并自动生成审计摘要；普通确认无需填写备注。</p></div>
            <label><span>操作者</span><input value={actor} onChange={(event) => { markDraftDirty(); setActor(event.target.value); }}/></label>
            <label><span>补充说明（选填）</span><input value={note} onChange={(event) => { markDraftDirty(); setNote(event.target.value); }} placeholder="确有需要时补充上下文"/></label>
            <div className="ruling-actions">{detail.objectType === "item-identity"
              ? <button disabled={busy || !!pendingPostCommitRefresh || !identityLevelValid} onClick={() => completeReview(identityDecision)}>{identityDecision === "modify" ? <Save size={15}/> : <Check size={15}/>} {identityDecision === "modify" ? "修改后确认" : "确认无误"}</button>
              : detail.objectType === "merge-relation"
                ? <button disabled={busy || !!pendingPostCommitRefresh || !!relationError} onClick={() => completeReview(relationDecision)}>{relationDecision === "modify" ? <Save size={15}/> : <Check size={15}/>} {relationDecision === "modify" ? "修改后确认" : "确认无误"}</button>
              : <><button disabled={busy || !!pendingPostCommitRefresh} onClick={() => completeReview("confirm")}><Check size={15}/>确认无误</button><button disabled={busy || !!pendingPostCommitRefresh} onClick={() => completeReview("modify")}><Save size={15}/>修改后确认</button></>}<button className="skip-review-action" disabled={busy || !!pendingPostCommitRefresh} onClick={skipCurrentReview}><SkipForward size={15}/>暂时跳过</button></div>
            {detail.catalogAuditSummary && <div className="catalog-audit-summary wide"><strong>Catalog Audit Summary</strong><span>{catalogAuditSummarySentence(detail.catalogAuditSummary)}</span></div>}
          </div>)}
          </> : <div className="release-control-rollback" role="status"><strong>普通完整快照入口已由发布开关隐藏</strong><p>已提交领域事实保持生效；旧高级诊断入口仍可用于检查、证据处置与回退期间的兼容操作。</p></div>}
          <details className="technical-review-details">
            <summary>只读技术详情</summary>
            <div className="technical-identity"><strong>内部对象标识</strong><code>{detail.objectType}/{detail.objectId}</code></div>
            <label><span>完整对象 JSON</span><textarea value={objectDraft} readOnly spellCheck={false}/></label>
            {!advancedJsonEditing
              ? <button className="ghost-btn advanced-json-entry" disabled={busy} onClick={beginAdvancedJsonEdit}>进入高级 JSON 编辑</button>
              : <div className="advanced-json-editor">
                <div><h3>高级 JSON 快照编辑</h3><p>此草稿与上方领域表单分离。只有通过结构、引用和领域不变量校验并再次确认后，才会保存完整快照。</p></div>
                <label><span>高级 JSON 草稿</span><textarea aria-label="高级 JSON 草稿" value={advancedJsonDraft} onChange={(event) => { markDraftDirty(); setAdvancedJsonDraft(event.target.value); setAdvancedJsonPreview(null); setAdvancedJsonError(null); }} spellCheck={false}/></label>
                {advancedJsonError && <div className="advanced-json-validation" role="alert"><strong>定位：{advancedJsonError.fieldPath}</strong><span>{advancedJsonError.message}</span></div>}
                <div className="advanced-json-actions"><button disabled={busy} onClick={previewAdvancedJsonSnapshot}>校验并预览影响</button><button className="ghost-btn" disabled={busy} onClick={() => { setAdvancedJsonEditing(false); setAdvancedJsonPreview(null); setAdvancedJsonError(null); }}>退出高级编辑</button></div>
                {advancedJsonPreview && <div className="advanced-json-confirmation" role="alertdialog" aria-label="确认高级 JSON 快照">
                  <h4>完整快照影响预览</h4>
                  <section><strong>人话差异</strong>{advancedJsonPreview.meaningfulDifferences?.length
                    ? advancedJsonPreview.meaningfulDifferences.map((difference: any) => <span key={difference.fieldPath}>{fieldLabel(difference.fieldPath)}：{display(difference.oldValue)} → {display(difference.newValue)}</span>)
                    : <span>领域值没有变化；仍会保存一份完整人工结论。</span>}</section>
                  <section><strong>影响范围</strong><span>{advancedJsonPreview.planningImpact?.summary || "当前没有直接关联的订单或合成关系。"}</span>
                    {(advancedJsonPreview.planningImpact?.orders || []).map((order: any) => <span key={order.slot}>订单 {order.slot} · {order.impactedItems.join("、")}</span>)}
                    {(advancedJsonPreview.planningImpact?.relations || []).map((relation: any) => <span key={relation.objectId}>{relation.sourceLabel} × 2 → {relation.targetLabel}</span>)}
                  </section>
                  <p>再次确认将提交整个对象快照、生成 Catalog Audit Summary 并立即重新规划。</p>
                  <div><button disabled={busy || !!pendingPostCommitRefresh} onClick={() => completeReview("modify", advancedJsonPreview.snapshot)}>确认提交完整快照</button><button className="ghost-btn" disabled={busy} onClick={() => setAdvancedJsonPreview(null)}>返回继续编辑</button></div>
                </div>}
              </div>}
            <div className="field-table"><div className="field-row head"><span>字段</span><span>生效值</span><span>算法候选</span><span>人工值</span></div>{fields.map((field) => <div className="field-row" key={field}><strong>{fieldLabel(field)}</strong><span>{display(detail.effectiveValue?.[field])}</span><span>{display(detail.algorithmCandidate?.[field])}</span><span>{display(detail.humanValues?.[field]?.value)}</span></div>)}</div>
            <div className="technical-history-grid">
              <div><h3>完整证据历史</h3>{detail.evidence?.map((evidence: any) => <p key={evidence.id}><strong>{valueLabel(evidence.sourceType)} · {valueLabel(evidence.disposition)}</strong><span>{valueLabel(evidence.sourceRef || "runtime")} · {evidence.observationCount} 次</span><code>{display(evidence.payload)}</code></p>)}</div>
              <div><h3>裁决历史</h3>{detail.rulingHistory?.length ? [...detail.rulingHistory].reverse().map((ruling: any) => <p key={ruling.id}><strong>{ruling.fieldPath} · {valueLabel(ruling.decision)}</strong><span>{ruling.actor} · {new Date(ruling.createdAt).toLocaleString()} · {display(ruling.oldValue)} → {display(ruling.newValue)} · {ruling.note}</span></p>) : <p><span>暂无人工裁决</span></p>}</div>
              <div><h3>对象演变</h3>{[...(detail.transitions || [])].reverse().map((transition: any) => <p key={`transition-${transition.id}`}><strong>{valueLabel(transition.fromStatus)} → {valueLabel(transition.toStatus)}</strong><span>{new Date(transition.createdAt).toLocaleString()} · {valueLabel(transition.fromDisposition)} → {valueLabel(transition.toDisposition)} · {valueLabel(transition.reason)}</span></p>)}{[...(detail.versions || [])].reverse().map((version: any) => <p key={`version-${version.id}`}><strong>版本 {version.version} · {valueLabel(version.status)}</strong><span>{new Date(version.createdAt).toLocaleString()} · {valueLabel(version.origin)}</span><code>{display(version.payload)}</code></p>)}</div>
              {detail.objectType === "item-identity" && <div><h3>图标识别技术记录</h3>{detail.iconCandidates?.map((candidate: any) => <p key={candidate.id}><code>{display(candidate)}</code></p>)}{detail.iconSelectionHistory?.map((entry: any) => <p key={entry.id}><code>{display(entry)}</code></p>)}</div>}
            </div>
          </details>
          <details className="advanced-review-actions" open={!ordinaryReviewEnabled}>
            <summary>高级诊断与证据处置</summary>
            <div className="object-planning-control">
              <div><h3>对象规划资格</h3><p>{detail.disposition === "paused" ? "当前对象已持久暂停；证据、候选、裁决与审计历史仍完整保留。" : "当前对象可按状态参与规划；暂停只改变规划资格，不会替代普通审核结论。"}</p></div>
              {detail.disposition === "paused"
                ? <button disabled={busy} onClick={togglePause}><Play size={14}/>立即恢复对象</button>
                : !pauseConfirmationOpen
                  ? <button className="danger" disabled={busy} onClick={togglePause}><Pause size={14}/>预览暂停影响</button>
                  : <div className="pause-impact-confirmation" role="alertdialog" aria-label="确认暂停对象">
                    <h4>暂停影响预览</h4>
                    <p>{detail.planningImpact?.summary || "正在核对受影响的订单与关系。"}</p>
                    <div className="pause-impact-grid">
                      <section><strong>受影响订单</strong>{detail.planningImpact?.orders?.length ? detail.planningImpact.orders.map((order: any) => <span key={order.slot}>订单 {order.slot} · {order.impactedItems.join("、")}</span>) : <span>当前没有直接受影响的订单</span>}</section>
                      <section><strong>受影响合成关系</strong>{detail.planningImpact?.relations?.length ? detail.planningImpact.relations.map((relation: any) => <span key={relation.objectId}>{relation.sourceLabel} × 2 → {relation.targetLabel}</span>) : <span>当前没有直接受影响的合成关系</span>}</section>
                    </div>
                    <p className="pause-impact-warning">再次确认后，对象会持久退出规划并立即重新规划；普通审核状态和全部历史保持不变。</p>
                    <div className="pause-impact-actions"><button className="danger" disabled={busy} onClick={togglePause}>确认暂停对象</button><button className="ghost-btn" disabled={busy} onClick={() => setPauseConfirmationOpen(false)}>取消</button></div>
                  </div>}
            </div>
            {pendingEvidenceRejection && <div className="evidence-rejection-confirmation" role="alertdialog" aria-label="确认否决证据">
              <h4>否决影响预览</h4>
              <p><strong>证据来源</strong> {valueLabel(pendingEvidenceRejection.sourceType)} · {valueLabel(pendingEvidenceRejection.sourceRef || "runtime")} · {pendingEvidenceRejection.observationCount} 次观测</p>
              <code>{display(pendingEvidenceRejection.payload)}</code>
              <p>{detail.planningImpact?.summary || "当前没有直接关联的订单或关系。"}</p>
              <p className="evidence-rejection-warning">确认后原始证据和来源仍保留审计，但它会从后续自动推断及规划融合中排除。</p>
              <div><button className="danger" disabled={busy} onClick={() => updateEvidenceDisposition(pendingEvidenceRejection.id, "rejected")}>确认否决证据</button><button className="ghost-btn" disabled={busy} onClick={() => setPendingEvidenceRejection(null)}>取消</button></div>
            </div>}
            <div className="review-evidence"><div><h3>证据采用与否决</h3>{detail.evidence?.map((evidence: any, index: number) => <p key={evidence.id}><strong>证据 {index + 1} · {valueLabel(evidence.sourceType)}</strong><span>{evidence.observationCount} 次 · {valueLabel(evidence.disposition)}</span><span className="evidence-actions"><button disabled={busy} onClick={() => acceptEvidence(evidence.id)}>采用证据</button>{evidence.disposition === "eligible" ? <><button disabled={busy} onClick={() => updateEvidenceDisposition(evidence.id, "paused")}>暂停证据</button><button className="danger" disabled={busy} onClick={() => updateEvidenceDisposition(evidence.id, "rejected")}>否决证据</button></> : <button disabled={busy} onClick={() => updateEvidenceDisposition(evidence.id, "eligible")}><RotateCcw size={13}/>恢复证据</button>}</span></p>)}</div></div>
          </details>
        </>}
      </div>
    </section>
  </>;
}
