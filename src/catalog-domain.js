"use strict";

const CATALOG_OBJECT_TYPES = new Set(["item-identity", "merge-relation", "production-profile", "production-mode"]);

function isCatalogObjectType(value) {
  return CATALOG_OBJECT_TYPES.has(String(value || ""));
}

module.exports = { CATALOG_OBJECT_TYPES, isCatalogObjectType };
