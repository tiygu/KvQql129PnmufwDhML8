"use strict";

function setDisplayIconSelection(database, object, candidateId, selectionOrigin, now) {
  const before = database.prepare(
    "SELECT * FROM catalog_icon_decisions WHERE object_id=?",
  ).get(object.id);
  database.prepare(`UPDATE catalog_icon_decisions
    SET selected_candidate_id=?,selection_origin=?,revision=revision+1,updated_at=?
    WHERE object_id=?`).run(candidateId, selectionOrigin, now, object.id);
  database.prepare(
    "UPDATE catalog_icon_candidates SET selected=0,selection_origin=NULL WHERE object_id=?",
  ).run(object.id);
  if (candidateId != null) {
    database.prepare(
      "UPDATE catalog_icon_candidates SET selected=1,selection_origin=? WHERE id=?",
    ).run(selectionOrigin, candidateId);
  }
  return {
    before,
    after: database.prepare(
      "SELECT * FROM catalog_icon_decisions WHERE object_id=?",
    ).get(object.id),
  };
}

function recordDisplayIconHistory(database, object, {
  candidateId = null,
  previousCandidateId = null,
  action,
  actor,
  note,
  decisionRevision,
  createdAt,
}) {
  database.prepare(`INSERT INTO catalog_icon_selection_history(
    object_id,candidate_id,previous_candidate_id,action,actor,note,
    object_revision,decision_revision,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
    object.id,
    candidateId,
    previousCandidateId,
    action,
    actor,
    note,
    Number(object.revision),
    Number(decisionRevision),
    createdAt,
  );
}

function displayIconManualProtection(database, objectId, selectionOrigin) {
  const latestControl = database.prepare(`SELECT action FROM catalog_icon_selection_history
    WHERE object_id=? AND action IN (
      'manual-select','manual-revoke','automatic-control-return'
    ) ORDER BY id DESC LIMIT 1`).get(objectId);
  return latestControl
    ? ["manual-select", "manual-revoke"].includes(latestControl.action)
    : selectionOrigin === "manual";
}

module.exports = {
  displayIconManualProtection,
  recordDisplayIconHistory,
  setDisplayIconSelection,
};
