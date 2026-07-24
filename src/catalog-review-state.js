"use strict";

const REAL_OBSERVATION_SOURCES = new Set(["runtime-capture", "structured-runtime", "passive-runtime", "passive-action-diff"]);

function mergeRelationWaitingForObservation({ relationCandidate = {}, relationEvidence = [], targetIdentity = null } = {}) {
  const hasInference = relationEvidence.some((evidence) => evidence.disposition !== "rejected" && evidence.sourceType === "structural-inference");
  const hasVerifiedMerge = relationEvidence.some((evidence) => evidence.disposition !== "rejected"
    && evidence.sourceType === "passive-action-diff" && evidence.payload?.mergeTarget != null);
  const targetObserved = targetIdentity?.evidence?.some((evidence) => evidence.disposition !== "rejected" && REAL_OBSERVATION_SOURCES.has(evidence.sourceType)) || false;
  const waiting = hasInference && !hasVerifiedMerge && (!relationCandidate.mergeTarget || !targetObserved);
  return waiting ? { waiting: true, reason: "merge-result-not-observed" } : { waiting: false, reason: null };
}

module.exports = { mergeRelationWaitingForObservation };
