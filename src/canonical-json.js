"use strict";

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sameJsonValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

module.exports = { canonicalValue, canonicalJson, sameJsonValue };
