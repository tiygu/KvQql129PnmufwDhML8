"use strict";

function isPlanActionable(plan, { hasMergeCandidate = false } = {}) {
  if (!plan) return false;
  if (typeof plan.actionable === "boolean") return plan.actionable;
  if (plan.feasible === false) return false;
  return !!(plan.ready || plan.mergeOnly || plan.producerSteps?.length || hasMergeCandidate);
}

module.exports = { isPlanActionable };
