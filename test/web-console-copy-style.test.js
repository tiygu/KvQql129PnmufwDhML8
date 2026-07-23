"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("网页控制台只使用统一字号令牌", () => {
  const files = ["web/src/styles.css", "web/src/settings.css", "web/src/tactical.css"];
  const violations = files.flatMap((file) => {
    const text = read(file);
    return [...text.matchAll(/font-size\s*:\s*\d+(?:\.\d+)?px/gi)].map((match) => `${file}: ${match[0]}`);
  });
  assert.deepEqual(violations, [], `发现硬编码字号：\n${violations.join("\n")}`);
});

test("网页控制台不再显示遗留英文操作文案", () => {
  const source = [read("web/src/App.tsx"), read("web/src/CatalogReviewWorkspace.tsx")].join("\n");
  const forbidden = [
    "Catalog evidence waiting",
    "Run Active Catalog Scan",
    "Warehouse Inventory Knowledge",
    "Safe sale suggestions",
    "Confirm sale",
    "Suggestion only",
    "Automatic execution disabled",
    "Waiting for orders",
    "Catalog Review Queue",
    "Icon candidate comparison",
    "Upload replacement",
    "Revoke selection",
    "Select candidate",
    "No icon candidates yet",
    "Icon selection history",
    "runtime icon",
    "Merge Garden Copilot",
    "\"Order ",
    ">Recommended<",
    "Complete {",
    "Energy {",
    "Efficiency {",
    "Missing {",
    "Board Space Feasibility",
    "Risk branches",
    "Pruned:",
    "Idle automation",
    "Sale verified",
  ];
  const violations = forbidden.filter((phrase) => source.includes(phrase));
  assert.deepEqual(violations, [], `发现遗留英文文案：${violations.join("、")}`);
});

test("图鉴审核列表只在真正选中后加载详情，并支持同一项重试", () => {
  const source = read("web/src/CatalogReviewWorkspace.tsx");
  assert.doesNotMatch(source, /\|\|\s*candidates\[0\]\s*\|\|\s*null/);
  assert.match(source, /loadingDetail/);
  assert.match(source, /loadError/);
  assert.match(source, /正在加载审核对象/);
  assert.match(source, />重试</);
  assert.match(source, /selectedKey\s*===\s*key[\s\S]*loadDetail\(entry\)/);
});

test("图鉴审核以完整快照确认且普通路径无需备注，并提供证据诊断入口", () => {
  const source = read("web/src/CatalogReviewWorkspace.tsx");
  const api = read("web/src/control-api.ts");

  assert.match(api, /completeCatalogReview:\s*\(input:\s*any\)\s*=>\s*post\("\/api\/catalog\/review\/complete",\s*input\)/);
  assert.match(api, /setCatalogEvidenceDisposition:\s*\(input:\s*any\)\s*=>\s*post\("\/api\/catalog\/evidence\/disposition",\s*input\)/);
  assert.match(source, /完整对象 JSON/);
  assert.match(source, />确认无误</);
  assert.match(source, />修改后确认</);
  assert.match(source, /补充说明（选填）/);
  assert.match(source, /snapshot,\s*actor/);
  assert.match(source, /requestId:\s*completionRequest\.current\.requestId/);
  assert.match(source, /controlApi\.completeCatalogReview/);
  assert.match(source, /controlApi\.setCatalogEvidenceDisposition/);
  for (const label of ["采用证据", "暂停证据", "否决证据", "恢复证据"]) assert.match(source, new RegExp(label));

  assert.match(source, /controlApi\.completeCatalogReview[\s\S]{0,2400}await\s+onChanged\([\s\S]{0,1200}setSelectedKey\(/);
  assert.match(source, /updated\.reviewStatus\s*===\s*"needs-review"\s*\|\|\s*!planningRecovered/);
  assert.match(source, /const\s+nextReviewKey\s*=[\s\S]{0,500}\?[\s\S]{0,300}:\s*null/);
  assert.match(source, /setSelectedKey\(nextReviewKey\)/);
});

test("图鉴证据风险入口直接定位第一个真实阻塞项", () => {
  const source = read("web/src/App.tsx");
  assert.match(source, /const evidenceReviewTarget = [\s\S]*blocker\.reviewTarget/);
  assert.match(source, /evidenceReviewTarget \? reviewEvidence\(evidenceReviewTarget\) : setTab\("catalog"\)/);
});

test("长合成链在面板内部滚动且整链图标可以无棋盘动作采集", () => {
  const source = read("web/src/App.tsx");
  const css = [read("web/src/styles.css"), read("web/src/tactical.css")].join("\n");
  assert.match(source, /采集整链图标/);
  assert.match(source, /const pendingItems = selectedChainItems;/);
  assert.match(css, /\.catalog-detail-grid[^}]*min-width:\s*0/);
  assert.match(css, /\.chain-view[^}]*min-width:\s*0/);
  assert.match(css, /\.chain-flow[^}]*overflow-x:\s*auto/);
});

test("仪表盘轮询保留完整图鉴 Repository，审核队列不会在刷新后消失", () => {
  const source = read("web/src/App.tsx");
  assert.match(source, /repository:\s*\{\s*\.\.\.old\.catalogView\?\.repository,\s*\.\.\.next\.catalogView\?\.repository\s*\}/);
});

test("棋盘图标映射不会被地图图标组件遮蔽", () => {
  const source = read("web/src/App.tsx");
  assert.match(source, /const boardCatalogItems = useMemo/);
  assert.match(source, /new globalThis\.Map\(/);
  assert.doesNotMatch(source, /const byId = new Map\(/);
});

test("自动化请求发出前立即进入运行态并让所有启动按钮显示停止色", () => {
  const source = read("web/src/App.tsx");
  const runBody = source.slice(source.indexOf("const run = async"), source.indexOf("const observeNow = async"));

  assert.match(runBody, /setData\([\s\S]*running:\s*true[\s\S]*paused:\s*false/);
  assert.ok(runBody.indexOf("running: true") < runBody.indexOf("await controlApi.start"));
  assert.match(source, /execute-next[^`"}]*\$\{data\.running\s*&&\s*!data\.paused\s*\?\s*"stop"/);
  assert.match(source, /className={`run-btn \$\{data\.running && !data\.paused \? "stop" : ""\}`}/);
});

test("自动化启动为单击执行且不再显示持续执行确认弹窗", () => {
  const source = read("web/src/App.tsx");
  const runBody = source.slice(source.indexOf("const run = async"), source.indexOf("const observeNow = async"));
  assert.doesNotMatch(runBody, /即将持续执行，直到完成一个订单或体力归零/);
  assert.doesNotMatch(runBody, /window\.confirm/);
});

test("图标候选无需隐藏备注前置条件并在请求完成前立即显示选中态", () => {
  const source = read("web/src/CatalogReviewWorkspace.tsx");
  const selectBody = source.slice(source.indexOf("const selectIcon = async"), source.indexOf("const revokeIcon = async"));

  assert.doesNotMatch(selectBody, /!note\.trim\(\)/);
  assert.match(selectBody, /const auditNote = note\.trim\(\) \|\| "手动选择图标候选"/);
  assert.match(selectBody, /setDetail\(markIconSelected\(detail, candidateId\)\)/);
  assert.ok(selectBody.indexOf("setDetail(markIconSelected") < selectBody.indexOf("await controlApi.selectCatalogIcon"));
});
