"use strict";

const crypto = require("node:crypto");

const TERMINAL_CHILD_STATES = new Set([
  "succeeded",
  "deferred",
  "failed",
  "cancelled",
]);

function requestFingerprint(value) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function conflictError(message, code, currentJob = null) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  if (currentJob) error.currentJob = currentJob;
  return error;
}

function parseJson(value) {
  return value == null ? null : JSON.parse(value);
}

function parentState(childState) {
  if (childState === "succeeded") return "succeeded";
  if (childState === "deferred") return "completed-with-gaps";
  if (childState === "failed") return "failed";
  if (childState === "cancelled") return "cancelled";
  if (childState === "cancelling") return "cancelling";
  return childState === "running" ? "running" : "queued";
}

class IconHarvestJobService {
  constructor({ database, onUpdate = null } = {}) {
    if (!database) throw new TypeError("database is required");
    this.database = database;
    this.onUpdate = onUpdate;
    this.jobsByRunnerTask = new Map();
    this.runnerTaskByJob = new Map();
    this.recoverUnfinished();
  }

  recoverUnfinished() {
    const rows = this.database.db.prepare(`
      SELECT job_id
      FROM icon_harvest_acquisitions
      WHERE state IN ('queued','running','cancelling')
      ORDER BY created_at,id
    `).all();
    for (const row of rows) {
      this._transition(row.job_id, {
        state: "deferred",
        stage: "runtime-restarted",
        reason: "runtime-restarted",
        retryable: true,
        operatorSummary: "运行时已重启，未完成的图标采集已延期，可重新发起任务。",
        technicalDetails: { reason: "runtime-restarted" },
        markStarted: false,
      });
    }
    return rows.length;
  }

  createSingleItem({
    itemId,
    idempotencyKey,
    retryOfJobId = null,
    fingerprint = null,
    withinTransaction = false,
  }) {
    const normalizedItemId = String(itemId || "").trim();
    const normalizedKey = String(idempotencyKey || "").trim();
    if (!normalizedItemId) throw new TypeError("Icon Harvest Job itemId is required");
    if (!normalizedKey) {
      const error = new TypeError("Icon Harvest Job idempotencyKey is required");
      error.code = "ICON_HARVEST_IDEMPOTENCY_KEY_REQUIRED";
      error.statusCode = 400;
      throw error;
    }
    const expectedFingerprint = fingerprint || requestFingerprint({
      command: "create",
      scope: { type: "item", itemId: normalizedItemId },
    });
    const commandUsingKey = this.database.db.prepare(
      "SELECT job_id FROM icon_harvest_commands WHERE idempotency_key=?",
    ).get(normalizedKey);
    if (commandUsingKey) {
      throw conflictError(
        "Icon Harvest Job idempotency key belongs to a different request",
        "ICON_HARVEST_IDEMPOTENCY_CONFLICT",
        this.get(commandUsingKey.job_id),
      );
    }
    const existing = this.database.db.prepare(
      "SELECT id,scope_key,request_fingerprint FROM icon_harvest_jobs WHERE idempotency_key=?",
    ).get(normalizedKey);
    if (existing) {
      if (existing.scope_key !== normalizedItemId
        || (existing.request_fingerprint && existing.request_fingerprint !== expectedFingerprint)) {
        throw conflictError(
          "Icon Harvest Job idempotency key belongs to a different request",
          "ICON_HARVEST_IDEMPOTENCY_CONFLICT",
          this.get(existing.id),
        );
      }
      return { snapshot: this.get(existing.id), idempotentReplay: true };
    }

    const now = new Date().toISOString();
    const jobId = `job_${crypto.randomUUID()}`;
    const acquisitionId = `acq_${crypto.randomUUID()}`;
    const insert = () => {
      this.database.db.prepare(`INSERT INTO icon_harvest_jobs(
        id,scope_type,scope_key,idempotency_key,request_fingerprint,retry_of_job_id,
        revision,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,1,?,?)`).run(
        jobId,
        "item",
        normalizedItemId,
        normalizedKey,
        expectedFingerprint,
        retryOfJobId == null ? null : String(retryOfJobId),
        now,
        now,
      );
      this.database.db.prepare(`INSERT INTO icon_harvest_acquisitions(
        id,job_id,item_id,state,stage,retryable,created_at,updated_at
      ) VALUES(?,?,?,'queued','queued',0,?,?)`).run(
        acquisitionId,
        jobId,
        normalizedItemId,
        now,
        now,
      );
    };
    if (withinTransaction) insert();
    else this.database.transaction(insert);
    return { snapshot: this.get(jobId), idempotentReplay: false };
  }

  findByIdempotencyKey(idempotencyKey) {
    const normalizedKey = String(idempotencyKey || "").trim();
    if (!normalizedKey) return null;
    const row = this.database.db.prepare(
      "SELECT id FROM icon_harvest_jobs WHERE idempotency_key=?",
    ).get(normalizedKey);
    return row ? this.get(row.id) : null;
  }

  trackRunnerTask(jobId, runnerTaskId) {
    const numericTaskId = Number(runnerTaskId);
    if (!Number.isInteger(numericTaskId)) return;
    if (!this.jobsByRunnerTask.has(numericTaskId)) {
      this.jobsByRunnerTask.set(numericTaskId, new Set());
    }
    this.jobsByRunnerTask.get(numericTaskId).add(String(jobId));
    this.runnerTaskByJob.set(String(jobId), numericTaskId);
    this.database.db.prepare(
      "UPDATE icon_harvest_acquisitions SET runner_task_id=? WHERE job_id=?",
    ).run(numericTaskId, String(jobId));
  }

  runnerTaskForJob(jobId) {
    const normalizedJobId = String(jobId);
    const inMemory = this.runnerTaskByJob.get(normalizedJobId);
    if (Number.isInteger(inMemory)) return inMemory;
    const row = this.database.db.prepare(
      "SELECT runner_task_id FROM icon_harvest_acquisitions WHERE job_id=?",
    ).get(normalizedJobId);
    return Number.isInteger(row?.runner_task_id) ? row.runner_task_id : null;
  }

  untrackRunnerTask(jobId) {
    const normalizedJobId = String(jobId);
    const runnerTaskId = this.runnerTaskForJob(normalizedJobId);
    this.runnerTaskByJob.delete(normalizedJobId);
    if (Number.isInteger(runnerTaskId)) {
      const jobIds = this.jobsByRunnerTask.get(runnerTaskId);
      jobIds?.delete(normalizedJobId);
      if (!jobIds?.size) this.jobsByRunnerTask.delete(runnerTaskId);
    }
    return runnerTaskId;
  }

  syncRunnerTask(jobId, task) {
    if (!task || task.status === "queued") return this.get(jobId);
    if (task.status === "running") {
      return this._transition(jobId, {
        state: "running",
        stage: "resolving",
      });
    }
    if (task.status === "complete") {
      const result = task.result || {};
      const snapshot = this._transition(jobId, {
        state: "succeeded",
        stage: "committed",
        result: {
          candidateId: result.candidate?.id ?? null,
          assetHash: result.candidate?.assetHash ?? null,
          provider: result.provider || result.candidate?.sourceType || null,
          cached: !!result.cached,
        },
      });
      return snapshot;
    }
    if (task.status === "deferred") {
      return this._transition(jobId, {
        state: "deferred",
        stage: "waiting-for-safe-boundary",
        reason: "automation-safe-boundary",
        retryable: true,
        operatorSummary: "采集条件暂不可用，可稍后重试。",
        technicalDetails: { message: task.error || null },
      });
    }
    if (task.status === "error") {
      return this._transition(jobId, {
        state: "failed",
        stage: "failed",
        reason: "icon-acquisition-failed",
        retryable: false,
        operatorSummary: "图标证据提交失败。",
        technicalDetails: { message: task.error || null },
      });
    }
    return this.get(jobId);
  }

  handleAcquisitionEvent(event) {
    const runnerTaskId = Number(event?.taskId);
    const jobIds = this.jobsByRunnerTask.get(runnerTaskId);
    if (!Number.isInteger(runnerTaskId) || !jobIds?.size) return [];
    const snapshots = [];
    for (const jobId of jobIds) {
      if (event.type === "icon-acquisition-queued") {
        snapshots.push(this._transition(jobId, {
          state: "queued",
          stage: event.stage || "waiting-for-runtime-slot",
          reason: event.reason || "automation-runtime-busy",
          retryable: true,
          operatorSummary: "运行时采集槽位正忙，任务会在安全边界继续。",
          technicalDetails: {
            reason: event.reason || "automation-runtime-busy",
          },
          markStarted: false,
        }));
        continue;
      }
      if (event.type === "icon-acquisition-started") {
        snapshots.push(this._transition(jobId, {
          state: "running",
          stage: event.stage || "resolving",
        }));
        continue;
      }
      if (event.type === "icon-acquisition-complete") {
        snapshots.push(this._transition(jobId, {
          state: "succeeded",
          stage: "committed",
          result: {
            candidateId: event.candidate?.id ?? null,
            assetHash: event.candidate?.assetHash ?? null,
            provider: event.provider || event.candidate?.sourceType || null,
            cached: !!event.cached,
          },
        }));
        continue;
      }
      if (event.type === "icon-acquisition-deferred") {
        snapshots.push(this._transition(jobId, {
          state: "deferred",
          stage: event.stage || "deferred",
          reason: event.reason || event.code || "prerequisite-unavailable",
          retryable: event.retryable !== false,
          operatorSummary: event.operatorSummary || "采集条件暂不可用，可稍后重试。",
          technicalDetails: event.technicalDetails || null,
        }));
        continue;
      }
      if (event.type === "icon-acquisition-error") {
        snapshots.push(this._transition(jobId, {
          state: "failed",
          stage: event.stage || "failed",
          reason: event.reason || event.code || "icon-acquisition-failed",
          retryable: !!event.retryable,
          operatorSummary: event.operatorSummary || "图标证据提交失败。",
          technicalDetails: event.technicalDetails || { message: event.error || null },
        }));
        continue;
      }
      if (event.type === "icon-acquisition-cancelled") {
        snapshots.push(this._transition(jobId, {
          state: "cancelled",
          stage: "cancelled",
          reason: event.reason || "subscriber-cancelled",
          retryable: true,
          operatorSummary: "图标采集订阅已取消。",
          technicalDetails: event.technicalDetails || null,
        }));
      }
    }
    if (snapshots.some((snapshot) => TERMINAL_CHILD_STATES.has(snapshot?.children?.[0]?.state))) {
      this.jobsByRunnerTask.delete(runnerTaskId);
    }
    return snapshots.filter(Boolean);
  }

  failToStart(jobId, error) {
    return this._transition(jobId, {
      state: "failed",
      stage: "queued",
      reason: error?.code || "icon-acquisition-queue-failed",
      operatorSummary: "任务未能进入采集队列。",
      technicalDetails: { message: error?.message || String(error) },
      markStarted: false,
    });
  }

  get(jobId) {
    const job = this.database.db.prepare(
      "SELECT * FROM icon_harvest_jobs WHERE id=?",
    ).get(String(jobId));
    if (!job) return null;
    const children = this.database.db.prepare(
      "SELECT * FROM icon_harvest_acquisitions WHERE job_id=? ORDER BY created_at,id",
    ).all(job.id).map((row) => ({
      acquisitionId: row.id,
      itemId: row.item_id,
      state: row.state,
      stage: row.stage,
      reason: row.reason_code || null,
      retryable: !!row.retryable,
      operatorSummary: row.operator_summary || null,
      technicalDetails: parseJson(row.technical_details_json),
      result: parseJson(row.result_json),
      runnerTaskId: Number.isInteger(row.runner_task_id) ? row.runner_task_id : null,
      createdAt: row.created_at,
      startedAt: row.started_at || null,
      completedAt: row.completed_at || null,
      updatedAt: row.updated_at,
    }));
    const terminal = {
      succeeded: children.filter((child) => child.state === "succeeded").length,
      deferred: children.filter((child) => child.state === "deferred").length,
      failed: children.filter((child) => child.state === "failed").length,
      cancelled: children.filter((child) => child.state === "cancelled").length,
    };
    const settled = Object.values(terminal).reduce((sum, count) => sum + count, 0);
    const child = children[0];
    const state = parentState(child?.state || "queued");
    return {
      jobId: job.id,
      revision: Number(job.revision),
      scope: { type: job.scope_type, itemId: job.scope_key },
      retryOfJobId: job.retry_of_job_id || null,
      state,
      finalStatus: TERMINAL_CHILD_STATES.has(child?.state) ? state : null,
      stage: child?.stage || "queued",
      reason: child?.reason || null,
      progress: {
        settled,
        total: children.length,
        terminal,
      },
      children,
      createdAt: job.created_at,
      startedAt: job.started_at || null,
      completedAt: job.completed_at || null,
      updatedAt: job.updated_at,
    };
  }

  list() {
    return this.database.db.prepare(
      "SELECT id FROM icon_harvest_jobs ORDER BY created_at DESC,id DESC",
    ).all().map((row) => this.get(row.id));
  }

  publish(jobId) {
    const snapshot = this.get(jobId);
    if (snapshot) this.onUpdate?.(snapshot);
    return snapshot;
  }

  beginCancel({ jobId, expectedRevision, idempotencyKey }) {
    const normalizedJobId = String(jobId || "");
    const normalizedKey = String(idempotencyKey || "").trim();
    const revision = Number(expectedRevision);
    if (!normalizedJobId || !normalizedKey || !Number.isInteger(revision)) {
      const error = new TypeError("Icon Harvest Job cancellation requires jobId, expectedRevision, and idempotencyKey");
      error.code = "ICON_HARVEST_CANCEL_INVALID";
      error.statusCode = 400;
      throw error;
    }
    const fingerprint = requestFingerprint({
      command: "cancel",
      jobId: normalizedJobId,
      expectedRevision: revision,
    });
    const existingCommand = this.database.db.prepare(
      "SELECT * FROM icon_harvest_commands WHERE idempotency_key=?",
    ).get(normalizedKey);
    if (existingCommand) {
      if (existingCommand.command_type !== "cancel"
        || existingCommand.request_fingerprint !== fingerprint) {
        throw conflictError(
          "Icon Harvest Job idempotency key belongs to a different request",
          "ICON_HARVEST_IDEMPOTENCY_CONFLICT",
          this.get(existingCommand.job_id),
        );
      }
      return { snapshot: this.get(existingCommand.job_id), idempotentReplay: true };
    }
    const jobUsingKey = this.database.db.prepare(
      "SELECT id FROM icon_harvest_jobs WHERE idempotency_key=?",
    ).get(normalizedKey);
    if (jobUsingKey) {
      throw conflictError(
        "Icon Harvest Job idempotency key belongs to a different request",
        "ICON_HARVEST_IDEMPOTENCY_CONFLICT",
        this.get(jobUsingKey.id),
      );
    }

    const before = this.get(normalizedJobId);
    if (!before) {
      const error = new Error("Icon Harvest Job not found");
      error.code = "ICON_HARVEST_NOT_FOUND";
      error.statusCode = 404;
      throw error;
    }
    if (before.revision !== revision) {
      throw conflictError(
        "Icon Harvest Job revision changed",
        "ICON_HARVEST_REVISION_CONFLICT",
        before,
      );
    }

    const now = new Date().toISOString();
    const changed = this.database.transaction(() => {
      this.database.db.prepare(`INSERT INTO icon_harvest_commands(
        idempotency_key,command_type,request_fingerprint,job_id,created_at
      ) VALUES(?,?,?,?,?)`).run(
        normalizedKey,
        "cancel",
        fingerprint,
        normalizedJobId,
        now,
      );
      const result = this.database.db.prepare(`UPDATE icon_harvest_acquisitions SET
        state='cancelling',stage='cancelling',reason_code='operator-cancelled',
        retryable=1,operator_summary='正在取消图标采集任务。',
        updated_at=?
        WHERE job_id=? AND state NOT IN ('succeeded','deferred','failed','cancelled')`).run(
        now,
        normalizedJobId,
      );
      if (!result.changes) return false;
      this.database.db.prepare(`UPDATE icon_harvest_jobs SET
        revision=revision+1,updated_at=?
        WHERE id=?`).run(now, normalizedJobId);
      return true;
    });
    const snapshot = changed ? this.publish(normalizedJobId) : this.get(normalizedJobId);
    return { snapshot, idempotentReplay: false };
  }

  finishCancel(jobId) {
    return this._transition(String(jobId), {
      state: "cancelled",
      stage: "cancelled",
      reason: "operator-cancelled",
      retryable: true,
      operatorSummary: "图标采集任务已取消；已提交证据继续保留。",
      technicalDetails: { reason: "operator-cancelled" },
    });
  }

  createRetry({ jobId, expectedRevision, idempotencyKey }) {
    const normalizedJobId = String(jobId || "");
    const normalizedKey = String(idempotencyKey || "").trim();
    const revision = Number(expectedRevision);
    const fingerprint = requestFingerprint({
      command: "retry",
      jobId: normalizedJobId,
      expectedRevision: revision,
      unresolved: "default",
    });
    const commandUsingKey = this.database.db.prepare(
      "SELECT job_id FROM icon_harvest_commands WHERE idempotency_key=?",
    ).get(normalizedKey);
    if (commandUsingKey) {
      throw conflictError(
        "Icon Harvest Job idempotency key belongs to a different request",
        "ICON_HARVEST_IDEMPOTENCY_CONFLICT",
        this.get(commandUsingKey.job_id),
      );
    }
    const existing = this.database.db.prepare(
      "SELECT id,request_fingerprint FROM icon_harvest_jobs WHERE idempotency_key=?",
    ).get(normalizedKey);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        throw conflictError(
          "Icon Harvest Job idempotency key belongs to a different request",
          "ICON_HARVEST_IDEMPOTENCY_CONFLICT",
          this.get(existing.id),
        );
      }
      return { snapshot: this.get(existing.id), idempotentReplay: true };
    }
    const source = this.get(normalizedJobId);
    if (!source) {
      const error = new Error("Icon Harvest Job not found");
      error.code = "ICON_HARVEST_NOT_FOUND";
      error.statusCode = 404;
      throw error;
    }
    if (!Number.isInteger(revision) || source.revision !== revision) {
      throw conflictError(
        "Icon Harvest Job revision changed",
        "ICON_HARVEST_REVISION_CONFLICT",
        source,
      );
    }
    const unresolved = source.children.filter((child) => child.state !== "succeeded");
    if (!source.finalStatus || !unresolved.length) {
      throw conflictError(
        "Icon Harvest Job has no settled unresolved work to retry",
        "ICON_HARVEST_RETRY_NOT_AVAILABLE",
        source,
      );
    }
    if (unresolved.length !== 1) {
      throw conflictError(
        "single-item Icon Harvest Job retry requires exactly one unresolved acquisition",
        "ICON_HARVEST_RETRY_SCOPE_UNSUPPORTED",
        source,
      );
    }
    const now = new Date().toISOString();
    let created;
    this.database.transaction(() => {
      created = this.createSingleItem({
        itemId: unresolved[0].itemId,
        idempotencyKey: normalizedKey,
        retryOfJobId: source.jobId,
        fingerprint,
        withinTransaction: true,
      });
      const claimed = this.database.db.prepare(
        "UPDATE icon_harvest_jobs SET revision=revision+1,updated_at=? WHERE id=? AND revision=?",
      ).run(now, source.jobId, revision);
      if (claimed.changes !== 1) {
        throw conflictError(
          "Icon Harvest Job revision changed",
          "ICON_HARVEST_REVISION_CONFLICT",
          this.get(source.jobId),
        );
      }
    });
    this.publish(source.jobId);
    return created;
  }

  _transition(jobId, {
    state,
    stage,
    reason = null,
    retryable = false,
    operatorSummary = null,
    technicalDetails = null,
    result = null,
    markStarted = true,
  }) {
    const now = new Date().toISOString();
    const changed = this.database.transaction(() => {
      const child = this.database.db.prepare(
        "SELECT * FROM icon_harvest_acquisitions WHERE job_id=?",
      ).get(String(jobId));
      if (!child || TERMINAL_CHILD_STATES.has(child.state)) return false;
      const terminal = TERMINAL_CHILD_STATES.has(state);
      this.database.db.prepare(`UPDATE icon_harvest_acquisitions SET
        state=?,stage=?,reason_code=?,retryable=?,operator_summary=?,
        technical_details_json=?,result_json=?,
        started_at=COALESCE(started_at,?),
        completed_at=CASE WHEN ? THEN ? ELSE completed_at END,
        updated_at=?
        WHERE id=?`).run(
        state,
        stage,
        reason,
        retryable ? 1 : 0,
        operatorSummary,
        technicalDetails == null ? null : JSON.stringify(technicalDetails),
        result == null ? null : JSON.stringify(result),
        markStarted ? now : null,
        terminal ? 1 : 0,
        now,
        now,
        child.id,
      );
      this.database.db.prepare(`UPDATE icon_harvest_jobs SET
        revision=revision+1,
        started_at=COALESCE(started_at,?),
        completed_at=CASE WHEN ? THEN ? ELSE completed_at END,
        updated_at=?
        WHERE id=?`).run(
        markStarted ? now : null,
        terminal ? 1 : 0,
        now,
        now,
        String(jobId),
      );
      return true;
    });
    if (!changed) return this.get(jobId);
    const snapshot = this.publish(jobId);
    if (TERMINAL_CHILD_STATES.has(snapshot?.children?.[0]?.state)) {
      for (const [runnerTaskId, jobIds] of this.jobsByRunnerTask.entries()) {
        jobIds.delete(String(jobId));
        if (!jobIds.size) this.jobsByRunnerTask.delete(runnerTaskId);
      }
      this.runnerTaskByJob.delete(String(jobId));
    }
    return snapshot;
  }
}

module.exports = {
  IconHarvestJobService,
  TERMINAL_CHILD_STATES,
  parentState,
};
