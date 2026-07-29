export type CatalogMutationLane = "semantic" | "display-icon";

export type CatalogMutationPhase =
  | "idle"
  | "preparing"
  | "prepared"
  | "submitting"
  | "committed-refreshing"
  | "committed-refresh-needed"
  | "conflicted"
  | "failed";

export type CatalogMutationStatus =
  | "committed"
  | "committed-refresh-needed"
  | "conflict"
  | "validation-error"
  | "unavailable"
  | "failed"
  | "optimistic-rolled-back"
  | "prepared"
  | "stale-preparation";

export type CatalogMutationIntent =
  | { type: "complete-review"; decision: "confirm" | "modify"; snapshot: any; actor: string; note?: string }
  | { type: "preview-review"; snapshot: any }
  | { type: "skip-review" }
  | { type: "set-object-disposition"; disposition: string; reason: string }
  | { type: "set-evidence-disposition"; evidenceId: number; disposition: string; reason: string; actor?: string; note?: string; action?: string }
  | { type: "acquire-icon"; idempotencyKey: string }
  | { type: "select-icon"; candidateId: number; actor: string; note: string }
  | { type: "revoke-icon"; actor: string; note: string }
  | { type: "upload-icon"; dataBase64: string; mimeType: string; actor: string; note: string };

export type CatalogMutationOutcome = {
  status: CatalogMutationStatus;
  lane: CatalogMutationLane;
  object?: any;
  result?: any;
  refreshedCatalog?: any;
  error?: any;
  preparedId?: string;
};

type LaneSnapshot = {
  phase: CatalogMutationPhase;
  objectKey: string | null;
  error: string | null;
};

type CoordinatorSnapshot = {
  semantic: LaneSnapshot;
  displayIcon: LaneSnapshot;
};

type CoordinatorOptions = {
  client: any;
  refresh?: (() => Promise<any>) | null;
  onDetail?: ((detail: any) => void) | null;
  randomId?: (() => string) | null;
};

function clone<T>(value: T): T {
  return value == null ? value : structuredClone(value);
}

function objectKey(value: any) {
  return value ? `${value.objectType}:${value.objectId}` : null;
}

function displayRevision(value: any) {
  return Number(value?.displayIcon?.revision ?? -1);
}

function semanticRevision(value: any) {
  return Number(value?.revision ?? -1);
}

function defaultRandomId() {
  return globalThis.crypto?.randomUUID?.()
    || `catalog-mutation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function canonical(value: any) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function laneFor(intent: CatalogMutationIntent): CatalogMutationLane {
  return ["acquire-icon", "select-icon", "revoke-icon", "upload-icon"].includes(intent.type)
    ? "display-icon"
    : "semantic";
}

function idleLane(): LaneSnapshot {
  return { phase: "idle", objectKey: null, error: null };
}

function iconSlice(value: any) {
  return {
    displayIcon: clone(value?.displayIcon),
    iconCandidates: clone(value?.iconCandidates),
    selectedIcon: clone(value?.selectedIcon),
    iconSelectionHistory: clone(value?.iconSelectionHistory),
  };
}

function mergeLane(current: any, incoming: any, lane: CatalogMutationLane) {
  if (!current) return clone(incoming);
  if (!incoming) return clone(current);
  if (objectKey(current) !== objectKey(incoming)) return clone(current);
  if (lane === "display-icon") {
    if (displayRevision(incoming) < displayRevision(current)) return clone(current);
    return { ...clone(current), ...iconSlice(incoming) };
  }
  if (semanticRevision(incoming) < semanticRevision(current)) return clone(current);
  const preservedIcon = iconSlice(current);
  const merged = { ...clone(incoming) };
  if (displayRevision(current) > displayRevision(incoming)) Object.assign(merged, preservedIcon);
  return merged;
}

function optimisticIcon(current: any, candidateId: number) {
  const candidate = (current?.displayIcon?.candidates || current?.iconCandidates || [])
    .find((item: any) => Number(item.id) === Number(candidateId));
  if (!candidate) return clone(current);
  const displayIcon = {
    ...(current.displayIcon || {}),
    selectedCandidateId: Number(candidateId),
    selectedIcon: clone(candidate),
  };
  return {
    ...clone(current),
    displayIcon,
    selectedIcon: clone(candidate),
  };
}

export class CatalogReviewMutationCoordinator {
  private readonly client: any;
  private refresh: (() => Promise<any>) | null;
  private readonly onDetail: ((detail: any) => void) | null;
  private readonly randomId: () => string;
  private detail: any = null;
  private lanes: CoordinatorSnapshot = { semantic: idleLane(), displayIcon: idleLane() };
  private listeners = new Set<() => void>();
  private prepared = new Map<string, { intent: CatalogMutationIntent; lane: CatalogMutationLane; objectKey: string; revision: number }>();
  private completionRequest: { key: string; requestId: string } | null = null;
  private pendingRefresh: { lane: CatalogMutationLane; object: any; result: any } | null = null;

  constructor(options: CoordinatorOptions) {
    this.client = options.client;
    this.refresh = options.refresh || null;
    this.onDetail = options.onDetail || null;
    this.randomId = options.randomId || defaultRandomId;
  }

  setRefresh(refresh: (() => Promise<any>) | null) {
    this.refresh = refresh;
  }

  setContext({ detail }: { detail: any }) {
    if (!detail) {
      if (this.detail) this.invalidatePrepared();
      this.detail = null;
      return;
    }
    if (!this.detail || objectKey(this.detail) !== objectKey(detail)) {
      this.detail = clone(detail);
      this.invalidatePrepared();
      return;
    }
    this.detail = mergeLane(this.detail, detail, "semantic");
    this.detail = mergeLane(this.detail, detail, "display-icon");
  }

  currentDetail() {
    return clone(this.detail);
  }

  snapshot(): CoordinatorSnapshot {
    return clone(this.lanes);
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  availability(intent: CatalogMutationIntent) {
    return this.laneAvailability(laneFor(intent));
  }

  laneAvailability(lane: CatalogMutationLane) {
    const phase = this.lanes[lane === "display-icon" ? "displayIcon" : "semantic"].phase;
    const available = phase === "idle" || phase === "failed" || phase === "conflicted";
    return {
      available,
      reason: available ? null : lane === "semantic" && phase === "committed-refresh-needed"
        ? "semantic-refresh-needed"
        : `${lane}-mutation-busy`,
    };
  }

  cancel(preparedId: string) {
    const prepared = this.prepared.get(String(preparedId));
    if (!prepared) return false;
    this.prepared.delete(String(preparedId));
    this.setLane(prepared.lane, idleLane());
    return true;
  }

  async prepare(intent: CatalogMutationIntent): Promise<CatalogMutationOutcome> {
    const lane = laneFor(intent);
    const detail = this.requireDetail();
    const availability = this.availability(intent);
    if (!availability.available) return { status: "unavailable", lane };
    this.setLane(lane, { phase: "preparing", objectKey: objectKey(detail), error: null });
    const preparedId = this.randomId();
    this.prepared.set(preparedId, {
      intent: clone(intent),
      lane,
      objectKey: objectKey(detail) || "",
      revision: lane === "display-icon" ? displayRevision(detail) : semanticRevision(detail),
    });
    this.setLane(lane, { phase: "prepared", objectKey: objectKey(detail), error: null });
    return { status: "prepared", lane, preparedId };
  }

  async confirm(
    preparedId: string,
    expectedIntent?: CatalogMutationIntent,
  ): Promise<CatalogMutationOutcome> {
    const prepared = this.prepared.get(String(preparedId));
    if (!prepared) return { status: "stale-preparation", lane: "semantic" };
    const current = this.detail;
    const currentRevision = prepared.lane === "display-icon"
      ? displayRevision(current)
      : semanticRevision(current);
    if (
      objectKey(current) !== prepared.objectKey
      || currentRevision !== prepared.revision
      || (expectedIntent && canonical(expectedIntent) !== canonical(prepared.intent))
    ) {
      this.prepared.delete(String(preparedId));
      this.setLane(prepared.lane, idleLane());
      return { status: "stale-preparation", lane: prepared.lane };
    }
    this.prepared.delete(String(preparedId));
    this.setLane(prepared.lane, idleLane());
    return this.execute(prepared.intent);
  }

  async execute(intent: CatalogMutationIntent): Promise<CatalogMutationOutcome> {
    const lane = laneFor(intent);
    const availability = this.availability(intent);
    if (!availability.available) return { status: "unavailable", lane };
    const before = this.requireDetail();
    const startedKey = objectKey(before);
    const startedRevision = lane === "display-icon" ? displayRevision(before) : semanticRevision(before);
    let optimisticBefore: any = null;
    if (intent.type === "select-icon") {
      optimisticBefore = clone(before);
      this.publishDetail(optimisticIcon(before, intent.candidateId), lane);
    }
    this.setLane(lane, { phase: "submitting", objectKey: startedKey, error: null });
    try {
      const result = await this.call(intent, before);
      if (this.detail && objectKey(this.detail) === startedKey && result && result.objectType) {
        this.publishDetail(mergeLane(this.detail, result, lane), lane);
      }
      if (intent.type === "complete-review" && this.refresh) {
        this.setLane(lane, { phase: "committed-refreshing", objectKey: startedKey, error: null });
        try {
          const refreshedCatalog = await this.refresh();
          this.pendingRefresh = null;
          this.setLane(lane, idleLane());
          return { status: "committed", lane, object: clone(result), result: clone(result), refreshedCatalog };
        } catch (error) {
          this.pendingRefresh = { lane, object: clone(result), result: clone(result) };
          this.setLane(lane, {
            phase: "committed-refresh-needed",
            objectKey: startedKey,
            error: error instanceof Error ? error.message : String(error),
          });
          return { status: "committed-refresh-needed", lane, object: clone(result), result: clone(result), error };
        }
      }
      this.setLane(lane, idleLane());
      return { status: "committed", lane, object: clone(result), result: clone(result) };
    } catch (error: any) {
      if (optimisticBefore && objectKey(this.detail) === startedKey
        && displayRevision(this.detail) <= startedRevision) {
        this.publishDetail(mergeLane(this.detail, optimisticBefore, "display-icon"), "display-icon");
      }
      const conflict = error?.payload?.code === "CATALOG_REVISION_CONFLICT"
        || error?.code === "CATALOG_REVISION_CONFLICT"
        || error?.status === 409;
      const validation = error?.status === 400 || error?.payload?.code === "CATALOG_SNAPSHOT_VALIDATION";
      const currentObject = error?.payload?.currentObject;
      if (currentObject && objectKey(this.detail) === startedKey) {
        this.publishDetail(mergeLane(this.detail, currentObject, lane), lane);
      }
      this.setLane(lane, {
        phase: conflict ? "conflicted" : "failed",
        objectKey: startedKey,
        error: error?.message || String(error),
      });
      return {
        status: conflict ? "conflict" : validation ? "validation-error" : "failed",
        lane,
        object: clone(currentObject),
        error,
      };
    }
  }

  async retryRefresh(): Promise<CatalogMutationOutcome> {
    if (!this.pendingRefresh || !this.refresh) return { status: "unavailable", lane: "semantic" };
    const pending = this.pendingRefresh;
    this.setLane(pending.lane, {
      phase: "committed-refreshing",
      objectKey: objectKey(pending.object),
      error: null,
    });
    try {
      const refreshedCatalog = await this.refresh();
      this.pendingRefresh = null;
      this.setLane(pending.lane, idleLane());
      return {
        status: "committed",
        lane: pending.lane,
        object: clone(pending.object),
        result: clone(pending.result),
        refreshedCatalog,
      };
    } catch (error: any) {
      this.setLane(pending.lane, {
        phase: "committed-refresh-needed",
        objectKey: objectKey(pending.object),
        error: error?.message || String(error),
      });
      return { status: "committed-refresh-needed", lane: pending.lane, object: clone(pending.object), error };
    }
  }

  private requireDetail() {
    if (!this.detail) throw new Error("catalog review detail is required");
    return clone(this.detail);
  }

  private invalidatePrepared() {
    this.prepared.clear();
    if (this.lanes.semantic.phase === "prepared") this.lanes.semantic = idleLane();
    if (this.lanes.displayIcon.phase === "prepared") this.lanes.displayIcon = idleLane();
    this.emit();
  }

  private setLane(lane: CatalogMutationLane, value: LaneSnapshot) {
    if (lane === "display-icon") this.lanes.displayIcon = value;
    else this.lanes.semantic = value;
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private publishDetail(value: any, lane: CatalogMutationLane) {
    this.detail = mergeLane(this.detail, value, lane);
    this.onDetail?.(clone(this.detail));
  }

  private async call(intent: CatalogMutationIntent, current: any) {
    const identity = { objectType: current.objectType, objectId: current.objectId };
    switch (intent.type) {
      case "complete-review": {
        const key = canonical({
          ...identity,
          revision: semanticRevision(current),
          decision: intent.decision,
          snapshot: intent.snapshot,
        });
        if (this.completionRequest?.key !== key) {
          this.completionRequest = { key, requestId: this.randomId() };
        }
        return this.client.completeCatalogReview({
          ...identity,
          decision: intent.decision,
          snapshot: clone(intent.snapshot),
          actor: intent.actor,
          ...(intent.note ? { note: intent.note } : {}),
          requestId: this.completionRequest.requestId,
          expectedRevision: semanticRevision(current),
        });
      }
      case "preview-review":
        return this.client.previewCatalogReview({
          ...identity,
          snapshot: clone(intent.snapshot),
          expectedRevision: semanticRevision(current),
        });
      case "skip-review":
        return this.client.skipCatalogReview(identity);
      case "set-object-disposition":
        return this.client.setCatalogObjectDisposition({
          ...identity,
          disposition: intent.disposition,
          reason: intent.reason,
          expectedRevision: semanticRevision(current),
        });
      case "set-evidence-disposition":
        return this.client.setCatalogEvidenceDisposition({
          ...identity,
          evidenceId: intent.evidenceId,
          disposition: intent.disposition,
          reason: intent.reason,
          actor: intent.actor,
          note: intent.note,
          action: intent.action,
          expectedRevision: semanticRevision(current),
        });
      case "acquire-icon":
        return this.client.createIconHarvestJob(
          current.objectId,
          intent.idempotencyKey,
        );
      case "select-icon":
        return this.client.selectCatalogIcon({
          objectId: current.objectId,
          candidateId: intent.candidateId,
          actor: intent.actor,
          note: intent.note,
          expectedDisplayIconRevision: displayRevision(current),
        });
      case "revoke-icon":
        return this.client.revokeCatalogIcon({
          objectId: current.objectId,
          actor: intent.actor,
          note: intent.note,
          expectedDisplayIconRevision: displayRevision(current),
        });
      case "upload-icon":
        return this.client.uploadCatalogIcon({
          objectId: current.objectId,
          dataBase64: intent.dataBase64,
          mimeType: intent.mimeType,
          actor: intent.actor,
          note: intent.note,
          expectedDisplayIconRevision: displayRevision(current),
        });
    }
  }
}

export function catalogMutationLane(intent: CatalogMutationIntent) {
  return laneFor(intent);
}
