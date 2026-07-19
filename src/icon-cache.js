"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function writeContentAddressedIcon(bytes, cacheDir) {
  const body = Buffer.from(bytes);
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  const directory = path.join(cacheDir, hash.slice(0, 2));
  const filePath = path.join(directory, `${hash}.png`);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(filePath)) {
    const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, body);
    try { fs.renameSync(temporary, filePath); } catch (error) { fs.rmSync(temporary, { force: true }); if (!fs.existsSync(filePath)) throw error; }
  }
  return { hash, filePath, byteSize: body.length };
}

module.exports = { writeContentAddressedIcon };
