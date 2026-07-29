const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationDatabase } = require("../src/automation-database");

test("SQLite持久化图鉴、设置、会话、动作日志和资源曲线", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-lab-db-"));
	const database = new AutomationDatabase(path.join(dir, "test.db"));
	const stats = database.importCatalog(
		{
			chains: [{ id: "c", minLevel: 1, maxLevel: 2, complete: true }],
			items: [
				{ id: "i", chainId: "c", level: 1, mergeTarget: "i2", baseUnits: 1 },
			],
			producers: [
				{
					itemId: "i",
					chainId: "c",
					level: 1,
					energyCost: 1,
					sampleSize: 10,
					drops: [{ itemId: "d", probability: 1, count: 10 }],
				},
			],
		},
		{ sourceFile: "catalog.json" },
	);
	assert.deepEqual(stats, {
		chains: 1,
		items: 1,
		producers: 1,
		drops: 1,
		observations: 1,
	});
	assert.deepEqual(database.getCatalogRepositorySummary(), {
		objects: 3,
		states: { observed: 3, provisional: 0, active: 0 },
		evidence: 3,
		observations: 3,
		versions: 3,
		conflicts: 0,
	});
	database.importCatalog(
		{
			chains: [{ id: "c", minLevel: 1, maxLevel: 2, complete: true }],
			items: [
				{ id: "i", chainId: "c", level: 1, mergeTarget: "i2", baseUnits: 1 },
			],
			producers: [
				{
					itemId: "i",
					chainId: "c",
					level: 1,
					energyCost: 1,
					sampleSize: 10,
					drops: [{ itemId: "d", probability: 1, count: 10 }],
				},
			],
		},
		{ sourceFile: "capture.json", sourceType: "runtime-capture" },
	);
	assert.deepEqual(database.getCatalogRepositorySummary(), {
		objects: 3,
		states: { observed: 3, provisional: 0, active: 0 },
		evidence: 6,
		observations: 6,
		versions: 3,
		conflicts: 0,
	});
	assert.ok(
		database
			.getCatalogObject("item-identity", "i")
			.evidenceSummary.sources.some(
				(source) =>
					source.sourceType === "runtime-capture" &&
					source.sourceRef === "capture.json",
			),
	);
	database.importCatalog(
		{
			chains: [{ id: "c", minLevel: 1, maxLevel: 2, complete: true }],
			items: [
				{ id: "i", chainId: "c", level: 1, mergeTarget: "i2", baseUnits: 1 },
			],
			producers: [
				{
					itemId: "i",
					chainId: "c",
					level: 1,
					energyCost: 1,
					sampleSize: 10,
					drops: [{ itemId: "d", probability: 1, count: 10 }],
				},
			],
		},
		{ sourceFile: "catalog.json" },
	);
	assert.deepEqual(database.getCatalogRepositorySummary(), {
		objects: 3,
		states: { observed: 3, provisional: 0, active: 0 },
		evidence: 6,
		observations: 6,
		versions: 3,
		conflicts: 0,
	});
	database.setSetting("autoMapUpgrade", false);
	assert.equal(database.getSetting("autoMapUpgrade"), false);
	const sessionId = database.startSession("observe", { maxActions: 5 });
	database.logAction({
		sessionId,
		sequence: 1,
		type: "scan",
		ok: true,
		details: { empty: 10 },
	});
	database.logResourceSample({
		sessionId,
		coins: 12,
		energy: 34,
		diamonds: 5,
		scene: "board",
	});
	database.endSession(sessionId, "complete");
	assert.equal(database.listRecentActions(5)[0].action_type, "scan");
	assert.deepEqual(
		database
			.listResourceSamples(5)
			.map(({ coins, energy, diamonds, scene }) => ({
				coins,
				energy,
				diamonds,
				scene,
			})),
		[{ coins: 12, energy: 34, diamonds: 5, scene: "board" }],
	);
	database.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

test("版本化 Catalog Repository 独立保存三类对象并幂等累计重复观测", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-lab-catalog-"));
	const file = path.join(dir, "catalog.db");
	const database = new AutomationDatabase(file);
	try {
		const identity = {
			objectType: "item-identity",
			objectId: "item-1",
			payload: { name: "Leaf", level: 1 },
			sourceType: "runtime",
			sourceRef: "capture-1",
		};
		database.observeCatalogObject(identity);
		database.observeCatalogObject(identity);
		database.observeCatalogObject({
			objectType: "merge-relation",
			objectId: "item-1",
			payload: { mergeTarget: "item-2" },
			sourceType: "runtime",
			sourceRef: "capture-1",
		});
		database.observeCatalogObject({
			objectType: "production-profile",
			objectId: "producer-1",
			payload: { energyCost: 1 },
			sourceType: "legacy-json",
			sourceRef: "catalog.json",
		});

		const objects = database.listCatalogObjects();
		assert.deepEqual(objects.map((object) => object.objectType).sort(), [
			"item-identity",
			"merge-relation",
			"production-profile",
		]);
		const storedIdentity = database.getCatalogObject("item-identity", "item-1");
		assert.equal(storedIdentity.status, "observed");
		assert.equal(storedIdentity.revision, 2);
		assert.equal(storedIdentity.evidenceSummary.evidenceCount, 1);
		assert.equal(storedIdentity.evidenceSummary.observationCount, 2);
		assert.deepEqual(storedIdentity.evidenceSummary.sources, [
			{ sourceType: "runtime", sourceRef: "capture-1", observationCount: 2 },
		]);
	} finally {
		database.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("Catalog 候选和生效版本保留历史并可在重启后读取", () => {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "adapter-lab-catalog-restart-"),
	);
	const file = path.join(dir, "catalog.db");
	let database = new AutomationDatabase(file);
	try {
		const observed = database.observeCatalogObject({
			objectType: "item-identity",
			objectId: "item-1",
			payload: { name: "Leaf" },
			sourceType: "runtime",
		});
		const provisional = database.saveCatalogVersion({
			objectType: "item-identity",
			objectId: "item-1",
			payload: { name: "Leaf", level: 1 },
			status: "provisional",
			expectedRevision: observed.revision,
		});
		const active = database.activateCatalogCandidate(
			"item-identity",
			"item-1",
			{ expectedRevision: provisional.revision },
		);
		database.close();

		database = new AutomationDatabase(file);
		const restored = database.getCatalogObject("item-identity", "item-1");
		assert.equal(restored.status, "active");
		assert.equal(restored.revision, active.revision);
		assert.deepEqual(restored.activeVersion.payload, {
			name: "Leaf",
			level: 1,
		});
		assert.equal(restored.candidateVersion, null);
		assert.deepEqual(
			restored.versions.map((version) => version.status),
			["observed", "provisional", "active"],
		);
		assert.deepEqual(
			restored.versions.find((version) => version.status === "provisional")
				.payload,
			{ name: "Leaf", level: 1 },
		);
		assert.deepEqual(restored.evidence[0].payload, { name: "Leaf" });
	} finally {
		database.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("Catalog revision 阻止并发控制台覆盖新版本", () => {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "adapter-lab-catalog-revision-"),
	);
	const file = path.join(dir, "catalog.db");
	const first = new AutomationDatabase(file);
	const second = new AutomationDatabase(file);
	try {
		const observed = first.observeCatalogObject({
			objectType: "merge-relation",
			objectId: "item-1",
			payload: { mergeTarget: "item-2" },
			sourceType: "runtime",
		});
		assert.throws(
			() =>
				first.saveCatalogVersion({
					objectType: "merge-relation",
					objectId: "item-1",
					payload: { mergeTarget: "item-2" },
					status: "provisional",
					expectedRevision: observed.revision,
					origin: "typo",
				}),
			/unsupported catalog version origin/,
		);
		assert.throws(
			() =>
				first.saveCatalogVersion({
					objectType: "merge-relation",
					objectId: "item-1",
					payload: { mergeTarget: "item-2" },
					status: "provisional",
				}),
			(error) => error.code === "CATALOG_REVISION_REQUIRED",
		);
		first.saveCatalogVersion({
			objectType: "merge-relation",
			objectId: "item-1",
			payload: { mergeTarget: "item-2" },
			status: "provisional",
			expectedRevision: observed.revision,
		});
		assert.throws(
			() =>
				second.saveCatalogVersion({
					objectType: "merge-relation",
					objectId: "item-1",
					payload: { mergeTarget: "item-3" },
					status: "provisional",
					expectedRevision: observed.revision,
				}),
			(error) => error.code === "CATALOG_REVISION_CONFLICT",
		);
		assert.equal(
			first.getCatalogObject("merge-relation", "item-1").versions.length,
			2,
		);
	} finally {
		first.close();
		second.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("Catalog 批量观测在任一条无效时整体回滚", () => {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "adapter-lab-catalog-rollback-"),
	);
	const database = new AutomationDatabase(path.join(dir, "catalog.db"));
	try {
		assert.throws(
			() =>
				database.observeCatalogBatch([
					{
						objectType: "item-identity",
						objectId: "item-1",
						payload: { level: 1 },
						sourceType: "runtime",
					},
					{
						objectType: "unknown",
						objectId: "bad",
						payload: {},
						sourceType: "runtime",
					},
				]),
			/unsupported catalog object type/,
		);
		assert.deepEqual(database.listCatalogObjects(), []);
	} finally {
		database.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
