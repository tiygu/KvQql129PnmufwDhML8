#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const args = process.argv.slice(2);
const get = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const configPath = path.resolve(get("--config", "wmpf/frida/config/addresses.20089.json"));
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const errors = [];
const hex = (s) => Buffer.from(String(s || "").replace(/\s+/g, ""), "hex");
const offset = (v) => typeof v === "number" ? v : parseInt(String(v || "0"), 16);

const sha256 = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
const existing = (value) => value && fs.existsSync(value) ? path.resolve(value) : null;
const discoverModulePath = () => {
  const explicit = get("--module") || process.env.APP_RUNTIME_MODULE || config.ModulePath;
  if (explicit) return existing(explicit);
  if (!process.env.APPDATA || process.platform !== "win32") return null;
  return existing(path.join(
    process.env.APPDATA, "Tencent", "xwechat", "xplugin", "plugins", "RadiumWMPF",
    String(config.Version), "extracted", "runtime", "flue.dll",
  ));
};

const readPeSections = (data) => {
  if (data.length < 0x40 || data.readUInt16LE(0) !== 0x5a4d) throw new Error("invalid DOS header");
  const pe = data.readUInt32LE(0x3c);
  if (pe + 24 > data.length || data.toString("ascii", pe, pe + 4) !== "PE\0\0") throw new Error("invalid PE header");
  const sectionCount = data.readUInt16LE(pe + 6);
  const optionalSize = data.readUInt16LE(pe + 20);
  const table = pe + 24 + optionalSize;
  const sections = [];
  for (let i = 0; i < sectionCount; i += 1) {
    const at = table + i * 40;
    if (at + 40 > data.length) throw new Error("truncated PE section table");
    sections.push({
      name: data.toString("ascii", at, at + 8).replace(/\0+$/, ""),
      virtualSize: data.readUInt32LE(at + 8),
      virtualAddress: data.readUInt32LE(at + 12),
      rawSize: data.readUInt32LE(at + 16),
      rawOffset: data.readUInt32LE(at + 20),
    });
  }
  return sections;
};

const rvaToFileOffset = (data, rva) => {
  const section = readPeSections(data).find((item) =>
    rva >= item.virtualAddress && rva < item.virtualAddress + Math.max(item.virtualSize, item.rawSize));
  if (!section) throw new Error(`RVA 0x${rva.toString(16)} is outside mapped sections`);
  const result = section.rawOffset + (rva - section.virtualAddress);
  if (result >= data.length) throw new Error(`RVA 0x${rva.toString(16)} maps past end of file`);
  return result;
};

if (!config.Version) errors.push("Version missing");
const load = config.LoadStartHook || { Offset: config.LoadStartHookOffset };
if (!load || !load.Offset) errors.push("LoadStartHook.Offset missing");
const filters = Array.isArray(config.CDPFilterHooks) ? config.CDPFilterHooks : [];
if (!filters.length && !config.CDPFilterHookOffset) errors.push("CDPFilterHooks missing");
for (const [i, hook] of filters.entries()) {
  for (const key of ["BranchOffset", "ContinueOffset", "ExpectedBytes"]) if (!hook[key]) errors.push(`CDPFilterHooks[${i}].${key} missing`);
  if (hook.BranchOffset && hook.ContinueOffset && offset(hook.ContinueOffset) <= offset(hook.BranchOffset)) errors.push(`CDPFilterHooks[${i}] continue must follow branch`);
}

const verify = args.includes("--verify");
const modulePath = discoverModulePath();
if (verify && !modulePath) errors.push("SAMPLE module path not found; pass --module or set APP_RUNTIME_MODULE");
if (modulePath) {
  const data = fs.readFileSync(modulePath);
  const digest = sha256(modulePath);
  if (config.ModuleSha256 && digest !== config.ModuleSha256.toUpperCase()) errors.push(`ModuleSha256 mismatch: ${digest}`);
  if (verify) {
    const check = (label, spec) => {
      const bytes = hex(spec.ExpectedBytes);
      if (!bytes.length) return errors.push(`${label} ExpectedBytes missing`);
      try {
        const at = rvaToFileOffset(data, offset(spec.Offset));
        if (data.subarray(at, at + bytes.length).compare(bytes) !== 0) errors.push(`${label} fingerprint mismatch at ${spec.Offset}`);
      } catch (error) { errors.push(`${label}: ${error.message}`); }
    };
    check("LoadStart", load);
    for (const hook of filters) check(`CDP/${hook.Role}`, { Offset: hook.BranchOffset, ExpectedBytes: hook.ExpectedBytes });
  }
}

const result = { ok: errors.length === 0, version: config.Version, config: configPath, module: modulePath, hooks: filters.length || 1, errors };
if (errors.length) { console.error(JSON.stringify(result, null, 2)); process.exitCode = 1; }
else console.log(JSON.stringify(result, null, 2));

module.exports = { readPeSections, rvaToFileOffset, discoverModulePath };
