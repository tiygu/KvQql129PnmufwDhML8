"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationDatabase } = require("../src/automation-database");

test("已选图标在数据库迁移目录后从当前内容寻址缓存恢复", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-asset-portability-"));
  const database = new AutomationDatabase(path.join(dir, "automation.db"));
  const itemId = "portable-icon-item";
  const body = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+R3v7WQAAAABJRU5ErkJggg==",
    "base64",
  );
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  const cacheDir = path.join(dir, "icon-cache", hash.slice(0, 2));
  const currentPath = path.join(cacheDir, `${hash}.png`);
  const obsoletePath = `D:\\moved-project\\data\\icon-cache\\${hash.slice(0, 2)}\\${hash}.png`;

  try {
    database.observeCatalogObject({
      objectType: "item-identity",
      objectId: itemId,
      payload: { itemId, chainId: "portable-icons", level: 1, baseUnits: 1 },
      sourceType: "runtime-capture",
      countDuplicate: false,
    });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(currentPath, body);
    database.saveIconCandidate({
      itemId,
      cacheKey: "portable-icon",
      sourceType: "cocos-runtime-resource",
      runtimeIdentifier: "portable-icon-item",
      asset: {
        hash,
        mimeType: "image/png",
        width: 1,
        height: 1,
        byteSize: body.length,
        filePath: obsoletePath,
      },
    });

    assert.equal(database.getSelectedIconCandidate(itemId)?.filePath, currentPath);
    assert.equal(database.getIconAsset(hash)?.filePath, currentPath);
    assert.equal(database.listIconAssets()[0]?.filePath, currentPath);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
