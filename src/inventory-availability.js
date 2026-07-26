"use strict";

function gridUnavailabilityReasons(grid) {
  const reasons = [];
  if (grid?.frozen) reasons.push("frozen");
  if (grid?.locked) reasons.push("locked");
  if (grid?.moveable === false) reasons.push("not-moveable");
  if (grid?.normal === false) reasons.push("not-normal");
  return reasons;
}

function isGridExecutable(grid) {
  return gridUnavailabilityReasons(grid).length === 0;
}

module.exports = { gridUnavailabilityReasons, isGridExecutable };
