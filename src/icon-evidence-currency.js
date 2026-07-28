"use strict";

const fs = require("node:fs");
const {
  displayIconManualProtection,
  recordDisplayIconHistory,
  setDisplayIconSelection,
} = require("./display-icon-persistence");

const ICON_EVIDENCE_POLICY_VERSION = "icon-evidence-currency-v1";
const CURRENT_RUNTIME_RECONSTRUCTION_VERSION = "2";

const SOURCE_CONTRACTS = new Map([
  ...["cocos-runtime-resource", "legacy-runtime", "runtime-resource"].map((sourceType) => [
    sourceType,
    {
      type: "runtime-resource",
      producer: "cocos-runtime-reconstruction",
      reconstructionVersion: CURRENT_RUNTIME_RECONSTRUCTION_VERSION,
      qualityContractVersion: "runtime-resource-quality-v1",
    },
  ]),
  ["screenshot-runtime", {
    type: "screenshot",
    producer: "runtime-screenshot",
    reconstructionVersion: null,
    qualityContractVersion: "runtime-screenshot-quality-v1",
  }],
  ...["manual", "manual-upload", "user-upload"].map((sourceType) => [
    sourceType,
    {
      type: "manual-upload",
      producer: "operator-import",
      reconstructionVersion: null,
      qualityContractVersion: "manual-upload-quality-v1",
    },
  ]),
]);

const OPERATOR_REASON_SUMMARIES = {
  "legacy-runtime-reconstruction-version-missing": "旧版运行时重建版本缺失，证据已过期。",
  "runtime-reconstruction-version-mismatch": "运行时重建版本已不符合当前策略，证据已过期。",
  "producer-contract-mismatch": "证据生产者与当前来源契约不一致，证据已过期。",
  "quality-contract-version-mismatch": "图像质量契约版本已不符合当前策略，证据已过期。",
  "runtime-reconstruction-version-current": "运行时重建证据符合当前策略。",
  "source-contract-does-not-require-runtime-reconstruction": "该来源契约不依赖运行时重建版本，证据保持当前。",
  "legacy-source-contract-unknown": "旧证据来源契约无法识别，证据已过期。",
};

function sourceContract(sourceType) {
  return SOURCE_CONTRACTS.get(String(sourceType || "")) || null;
}

function provenanceForNewCandidate({
  sourceType,
  producer,
  reconstructionVersion,
  qualityContractVersion,
}) {
  const contract = sourceContract(sourceType);
  return {
    producer: producer == null ? contract?.producer || String(sourceType || "unknown") : String(producer),
    reconstructionVersion: reconstructionVersion == null
      ? contract?.reconstructionVersion ?? null
      : String(reconstructionVersion),
    qualityContractVersion: qualityContractVersion == null
      ? contract?.qualityContractVersion || null
      : String(qualityContractVersion),
  };
}

function evaluation(status, reason) {
  return { status, reason, policyVersion: ICON_EVIDENCE_POLICY_VERSION };
}

function evaluateIconEvidenceCurrency({
  sourceType,
  producer,
  reconstructionVersion,
  qualityContractVersion,
}) {
  const contract = sourceContract(sourceType);
  if (!contract) return evaluation("stale", "legacy-source-contract-unknown");
  if (contract.type === "runtime-resource" && reconstructionVersion == null) {
    return evaluation("stale", "legacy-runtime-reconstruction-version-missing");
  }
  if (producer != null && String(producer) !== contract.producer) {
    return evaluation("stale", "producer-contract-mismatch");
  }
  if (contract.type === "runtime-resource"
    && String(reconstructionVersion) !== contract.reconstructionVersion) {
    return evaluation("stale", "runtime-reconstruction-version-mismatch");
  }
  if (qualityContractVersion != null
    && String(qualityContractVersion) !== contract.qualityContractVersion) {
    return evaluation("stale", "quality-contract-version-mismatch");
  }
  return contract.type === "runtime-resource"
    ? evaluation("current", "runtime-reconstruction-version-current")
    : evaluation("current", "source-contract-does-not-require-runtime-reconstruction");
}

function recordCurrencyChange(database, row, evaluation, evaluatedAt) {
  database.prepare(`INSERT INTO catalog_icon_currency_history(
    object_id,candidate_id,previous_status,status,reason,policy_version,summary,created_at
  ) VALUES(?,?,?,?,?,?,?,?)`).run(
    row.object_id,
    row.id,
    row.currency_status || "unknown",
    evaluation.status,
    evaluation.reason,
    evaluation.policyVersion,
    OPERATOR_REASON_SUMMARIES[evaluation.reason],
    evaluatedAt,
  );
}

function updateCurrencyProjection(database, evaluatedAt) {
  const rows = database.prepare("SELECT * FROM catalog_icon_candidates ORDER BY id").all();
  for (const row of rows) {
    const evaluation = evaluateIconEvidenceCurrency({
      sourceType: row.source_type,
      producer: row.producer,
      reconstructionVersion: row.reconstruction_version,
      qualityContractVersion: row.quality_contract_version,
    });
    const statusChanged = String(row.currency_status || "unknown") !== evaluation.status;
    const projectionChanged = statusChanged
      || row.currency_reason !== evaluation.reason
      || row.currency_policy_version !== evaluation.policyVersion
      || row.currency_evaluated_at == null;
    if (!projectionChanged) continue;
    if (statusChanged) recordCurrencyChange(database, row, evaluation, evaluatedAt);
    database.prepare(`UPDATE catalog_icon_candidates SET
      currency_status=?,currency_reason=?,currency_policy_version=?,currency_evaluated_at=?
      WHERE id=?`).run(
      evaluation.status,
      evaluation.reason,
      evaluation.policyVersion,
      evaluatedAt,
      row.id,
    );
  }
}

function setAutomaticSelection(database, object, candidateId, evaluatedAt) {
  const { after } = setDisplayIconSelection(
    database,
    object,
    candidateId,
    "automatic",
    evaluatedAt,
  );
  return Number(after.revision);
}

function clearAutomaticSelection(database, object, candidate, {
  action,
  note,
  evaluatedAt,
}) {
  const { after } = setDisplayIconSelection(
    database,
    object,
    null,
    null,
    evaluatedAt,
  );
  recordDisplayIconHistory(database, object, {
    previousCandidateId: candidate.id,
    action,
    actor: "icon-evidence-migration",
    note,
    decisionRevision: after.revision,
    createdAt: evaluatedAt,
  });
  return database.prepare("SELECT * FROM catalog_icon_decisions WHERE object_id=?").get(object.id);
}

function automaticCandidatePriority(left, right) {
  return Number(right.rank_score ?? right.rankScore)
    - Number(left.rank_score ?? left.rankScore)
    || Number(left.id) - Number(right.id);
}

function automaticCandidateEligible(candidate, {
  assetAvailable = (filePath) => fs.existsSync(filePath),
} = {}) {
  const status = candidate.currency_status ?? candidate.currency?.status;
  if (status !== "current" || candidate.superseded) return false;
  const filePath = candidate.file_path ?? candidate.filePath;
  if (filePath && !assetAvailable(filePath, candidate)) return false;
  const similarity = typeof candidate.similarity_json === "string"
    ? JSON.parse(candidate.similarity_json || "{}")
    : candidate.similarity || {};
  return similarity.qualityGate?.status !== "rejected";
}

function eligibleAutomaticCandidates(database, objectId, assetAvailable) {
  return database.prepare(`SELECT candidate.*,asset.file_path,
      EXISTS(
        SELECT 1 FROM catalog_icon_candidate_lineage lineage
        WHERE lineage.predecessor_candidate_id=candidate.id
      ) AS superseded
    FROM catalog_icon_candidates candidate
    JOIN catalog_icon_assets asset ON asset.hash=candidate.asset_hash
    WHERE candidate.object_id=?`).all(objectId)
    .filter((candidate) => automaticCandidateEligible(candidate, { assetAvailable }))
    .sort(automaticCandidatePriority);
}

function reconcileDisplaySelections(database, evaluatedAt, { assetAvailable } = {}) {
  const objects = database.prepare(`SELECT object.* FROM catalog_repository_objects object
    JOIN catalog_icon_decisions decision ON decision.object_id=object.id
    WHERE object.object_type='item-identity'
    ORDER BY object.id`).all();
  for (const object of objects) {
    let decision = database.prepare(
      "SELECT * FROM catalog_icon_decisions WHERE object_id=?",
    ).get(object.id);
    const manualProtection = displayIconManualProtection(
      database,
      object.id,
      decision.selection_origin,
    );
    if (manualProtection) {
      database.prepare(`UPDATE catalog_icon_decisions
        SET selection_origin='manual' WHERE object_id=?`).run(object.id);
      database.prepare(`UPDATE catalog_icon_candidates SET
        selection_origin=CASE WHEN id=? THEN 'manual' ELSE NULL END,
        selected=CASE WHEN id=? THEN 1 ELSE 0 END
        WHERE object_id=?`).run(
        decision.selected_candidate_id,
        decision.selected_candidate_id,
        object.id,
      );
      continue;
    }

    const eligibleCandidates = eligibleAutomaticCandidates(database, object.id, assetAvailable);
    const selected = decision.selected_candidate_id == null
      ? null
      : database.prepare(
        "SELECT * FROM catalog_icon_candidates WHERE id=? AND object_id=?",
      ).get(decision.selected_candidate_id, object.id);
    if (selected?.currency_status === "stale") {
      decision = clearAutomaticSelection(database, object, selected, {
        action: "automatic-invalidate-stale",
        note: `自动展示已清除：${OPERATOR_REASON_SUMMARIES[selected.currency_reason]}`,
        evaluatedAt,
      });
    } else if (selected && !eligibleCandidates.some((candidate) => candidate.id === selected.id)) {
      decision = clearAutomaticSelection(database, object, selected, {
        action: "automatic-invalidate-ineligible",
        note: "自动展示候选的图像资产或质量证据当前不可用，展示已清除。",
        evaluatedAt,
      });
    }
    if (decision.selected_candidate_id != null) continue;

    const candidate = eligibleCandidates[0];
    if (!candidate) continue;
    const revision = setAutomaticSelection(database, object, candidate.id, evaluatedAt);
    recordDisplayIconHistory(database, object, {
      candidateId: candidate.id,
      action: "automatic-select-current",
      actor: "icon-evidence-migration",
      note: "当前合格图标证据已填补自动展示空缺",
      decisionRevision: revision,
      createdAt: evaluatedAt,
    });
  }
}

function migrateIconEvidenceCurrency(
  database,
  evaluatedAt = new Date().toISOString(),
  options = {},
) {
  updateCurrencyProjection(database, evaluatedAt);
  reconcileDisplaySelections(database, evaluatedAt, options);
}

module.exports = {
  ICON_EVIDENCE_POLICY_VERSION,
  CURRENT_RUNTIME_RECONSTRUCTION_VERSION,
  automaticCandidateEligible,
  automaticCandidatePriority,
  evaluateIconEvidenceCurrency,
  migrateIconEvidenceCurrency,
  provenanceForNewCandidate,
};
