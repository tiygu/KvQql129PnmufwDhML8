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

  assert.match(source, /const\s+refreshedCatalog\s*=\s*await\s+onChanged\(\)/);
  assert.match(source, /refreshedCatalog\?\.repository\?\.reviewQueue/);
  assert.match(source, /planningResult\.blockingReviewTarget/);
  assert.match(source, /updated\.reviewStatus\s*===\s*"needs-review"\s*\|\|\s*!planningRecovered/);
  assert.match(source, /const\s+nextReviewKey\s*=[\s\S]{0,500}\?[\s\S]{0,300}:\s*null/);
  assert.match(source, /setSelectedKey\(nextReviewKey\)/);
  assert.match(source, />暂时跳过</);
  const skipReview = source.slice(source.indexOf("const skipCurrentReview"), source.indexOf("const completeReview"));
  assert.doesNotMatch(skipReview, /controlApi|onChanged/);
});

test("图鉴审核默认只展示领域摘要，原始数据和完整历史收进只读技术详情", () => {
  const source = read("web/src/CatalogReviewWorkspace.tsx");
  const defaultDetail = source.slice(
    source.indexOf('<div className="human-review-reason">'),
    source.indexOf('<details className="technical-review-details'),
  );
  const technicalDetail = source.slice(
    source.indexOf('<details className="technical-review-details'),
    source.indexOf("</details>", source.indexOf('<details className="technical-review-details')) + "</details>".length,
  );

  assert.match(defaultDetail, /证据摘要/);
  assert.match(defaultDetail, /有意义的差异/);
  assert.doesNotMatch(defaultDetail, /objectId|assetHash|sourceRef|rankScore|完整对象 JSON|rulingHistory|transitions|versions/);
  assert.match(technicalDetail, /只读技术详情/);
  assert.match(technicalDetail, /完整对象 JSON/);
  assert.match(technicalDetail, /readOnly/);
  assert.doesNotMatch(technicalDetail, /onChange=\{\(event\) => setObjectDraft/);
  assert.match(technicalDetail, /内部对象标识/);
  assert.match(technicalDetail, /完整证据历史/);
  assert.match(technicalDetail, /对象演变/);
});

test("高级 JSON 编辑与领域表单草稿分离，并在服务端预校验和二次确认后提交完整快照", () => {
  const source = read("web/src/CatalogReviewWorkspace.tsx");
  const api = read("web/src/control-api.ts");
  const technicalDetail = source.slice(
    source.indexOf('<details className="technical-review-details'),
    source.indexOf('<details className="advanced-review-actions'),
  );

  assert.match(api, /previewCatalogReview:\s*\(input:\s*any\)\s*=>\s*post\("\/api\/catalog\/review\/preview",\s*input\)/);
  assert.match(technicalDetail, /完整对象 JSON[\s\S]*readOnly/);
  assert.match(technicalDetail, /进入高级 JSON 编辑/);
  assert.match(source, /高级 JSON 草稿/);
  assert.match(source, /校验并预览影响/);
  assert.match(source, /确认提交完整快照/);
  assert.match(source, /advancedJsonDraft/);
  assert.match(source, /controlApi\.previewCatalogReview/);
  assert.match(source, /meaningfulDifferences/);
  assert.match(source, /planningImpact/);
  assert.match(source, /fieldPath/);
  assert.match(source, /保留当前 JSON 草稿/);
  assert.match(source, /completeReview\("modify",\s*advancedJsonPreview\.snapshot\)/);
});

test("本地审核草稿跨刷新必须明确恢复或放弃，revision 冲突保留草稿并展示最新差异", () => {
  const source = read("web/src/CatalogReviewWorkspace.tsx");
  const server = read("src/control-server.js");
  const runtime = read("src/automation-runtime.js");

  assert.match(source, /catalog-review-local-drafts-v1/);
  assert.match(source, /localStorage/);
  assert.match(source, /发现本地未提交草稿/);
  assert.match(source, /恢复本地草稿/);
  assert.match(source, /放弃本地草稿/);
  assert.match(source, /草稿基于 revision/);
  assert.match(source, /最新对象 revision/);
  assert.match(source, /按最新版本重新确认/);
  assert.match(source, /meaningfulDifferences/);
  assert.match(source, /保留当前对象、草稿与滚动位置/);
  assert.match(source, /CATALOG_REVISION_CONFLICT/);
  assert.match(server, /error\?\.meaningfulDifferences/);
  assert.match(runtime, /error\.meaningfulDifferences/);
});

test("图鉴审核展示以后再看集合，并从规划结果与版本基线生成人话解释", () => {
  const source = read("web/src/CatalogReviewWorkspace.tsx");
  const reasonBody = source.slice(source.indexOf("function humanReadableReason"), source.indexOf("function parseObjectDraft"));
  const differenceBody = source.slice(source.indexOf("function meaningfulDifferences"), source.indexOf("function humanReadableReason"));

  assert.match(source, /repository\?\.laterQueue/);
  assert.match(source, />以后再看</);
  assert.match(source, /不影响当前规划/);
  assert.match(reasonBody, /reviewResolution\?\.planningResult/);
  assert.match(reasonBody, /planning-recovery-pending/);
  assert.match(differenceBody, /reviewCandidateSnapshot\(detail\)/);
  assert.match(differenceBody, /reviewBaselineSnapshot\(detail\)/);
  assert.doesNotMatch(differenceBody, /JSON\.stringify\(oldValue/);
});

test("图鉴差异使用冲突证据候选，产出档案只展示所属产出物与自动维护集合", () => {
  const source = read("web/src/CatalogReviewWorkspace.tsx");
  const candidateBody = source.slice(source.indexOf("function reviewCandidate"), source.indexOf("function meaningfulDifferences"));
  const fieldMap = source.slice(source.indexOf("const domainFieldOrder"), source.indexOf("function domainFields"));

  assert.match(candidateBody, /evidence-conflict/);
  assert.match(candidateBody, /detail\?\.evidence/);
  assert.match(candidateBody, /evidence\.disposition === "eligible"/);
  assert.match(candidateBody, /display\(evidence\.payload\) !== display\(baseline\)/);
  assert.match(fieldMap, /"production-profile":\s*\[[^\]]*"candidateOutputs"/);
  assert.match(fieldMap, /"production-profile":\s*\[[^\]]*"productionModes"/);
  assert.doesNotMatch(fieldMap, /"production-profile":\s*\[[^\]]*"energyCost"/);
  assert.doesNotMatch(fieldMap, /"production-profile":\s*\[[^\]]*"theoreticalDistribution"/);
  assert.doesNotMatch(fieldMap, /"production-profile":\s*\[[^\]]*"observedDistribution"/);
  assert.match(source, /aria-label="产出档案内容"/);
  assert.match(source, /集合由真实动作自动维护/);
});

test("产出档位分开显示三类分布、样本稳定性且普通路径没有概率输入", () => {
  const source = read("web/src/CatalogReviewWorkspace.tsx");
  const modePanel = source.slice(
    source.indexOf('detail.objectType === "production-mode" && <section'),
    source.indexOf('<div className="candidate-snapshot">'),
  );

  assert.match(modePanel, /理论产出分布/);
  assert.match(modePanel, /真实观测分布/);
  assert.match(modePanel, /规划采用分布/);
  assert.match(modePanel, /样本量/);
  assert.match(modePanel, /低样本/);
  assert.match(modePanel, /未见产物余量/);
  assert.match(modePanel, /系统融合，普通审核只读/);
  assert.doesNotMatch(modePanel, /<input/);
});

test("对象暂停在高级诊断中先预览订单与关系并二次确认，恢复保持直接可用", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "web", "src", "CatalogReviewWorkspace.tsx"), "utf8");
  const advanced = source.slice(source.indexOf("advanced-review-actions"));

  for (const copy of ["对象规划资格", "预览暂停影响", "暂停影响预览", "受影响订单", "受影响合成关系", "确认暂停对象", "取消", "立即恢复对象"]) {
    assert.match(advanced, new RegExp(copy));
  }
  assert.match(source, /pauseConfirmationOpen/);
  assert.match(source, /detail\.planningImpact/);
  assert.match(source, /detail\.disposition === "paused"[\s\S]*togglePause/);
});

test("证据采用直接带入领域表单且否决先展示影响并二次确认", () => {
  const source = read("web/src/CatalogReviewWorkspace.tsx");
  const acceptBody = source.slice(source.indexOf("const acceptEvidence"), source.indexOf("const togglePause"));
  const advanced = source.slice(source.indexOf("advanced-review-actions"));

  assert.match(acceptBody, /setAdoptedEvidencePayload/);
  assert.match(acceptBody, /selected\.payload/);
  assert.match(acceptBody, /仍需确认完整对象/);
  assert.doesNotMatch(acceptBody, /disposition:\s*"paused"/);
  for (const copy of ["否决影响预览", "证据来源", "后续自动推断", "规划融合", "确认否决证据", "取消"]) {
    assert.match(advanced, new RegExp(copy));
  }
  assert.match(source, /pendingEvidenceRejection/);
  assert.match(source, /catalogAuditSummary/);
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

test("图鉴发布回退隐藏普通完整快照入口但保留旧高级诊断入口和已提交事实提示", () => {
  const source = read("web/src/CatalogReviewWorkspace.tsx");

  assert.match(source, /ordinaryReviewEnabled\s*=\s*repository\?\.releaseControl\?\.entryMode\s*!==\s*"legacy-advanced"/);
  assert.match(source, /普通完整快照入口已由发布开关隐藏/);
  assert.match(source, /已提交领域事实保持生效/);
  assert.match(source, /advanced-review-actions" open=\{!ordinaryReviewEnabled\}/);
});
