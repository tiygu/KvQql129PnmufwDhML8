#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const fieldsOf = (value) => value?.fields || value?.primitiveFields || {};
const arrayItems = (value) =>
	value?.kind === "Array" && Array.isArray(value.items) ? value.items : [];

function decodeSnapshotString(value) {
	if (typeof value === "string") return value;
	const fields = fieldsOf(value);
	if (value?.className !== "String") return null;
	return Object.keys(fields)
		.filter((key) => /^\d+$/.test(key))
		.sort((a, b) => Number(a) - Number(b))
		.map((key) => fields[key])
		.join("");
}

function normalizeItem(value) {
	const item = fieldsOf(value);
	return {
		id: item.id == null ? null : String(item.id),
		descriptionKey: item.Describe ?? null,
		itemType: item.ItemType ?? null,
		level: Number(item.Level ?? 0),
		chainId: item.MergeChain == null ? null : String(item.MergeChain),
		iconResource: item.IconRes ?? null,
		energyCost: Number(item.EnergyCost ?? 0),
		mergeTarget: item.MergeTarget == null ? null : String(item.MergeTarget),
		price: item.Price ?? null,
		coinValue: item.CoinValue ?? null,
		energyValue: item.EnergyValue ?? null,
		createData: arrayItems(item.CreateData)
			.map(decodeSnapshotString)
			.filter(Boolean),
	};
}

function buildCatalog(snapshots) {
	const chains = new Map();
	const items = new Map();
	const producers = new Map();

	const addItem = (item, completeChain = false) => {
		if (!item.id || !item.chainId) return;
		const current = items.get(item.id) || {};
		items.set(item.id, {
			...current,
			...item,
			baseUnits: item.level > 0 ? 2 ** (item.level - 1) : null,
		});
		if (!chains.has(item.chainId))
			chains.set(item.chainId, {
				id: item.chainId,
				titleKey: null,
				maxLevel: null,
				complete: false,
				itemIds: new Set(),
				observedNames: new Set(),
				sourceFiles: new Set(),
			});
		const chain = chains.get(item.chainId);
		chain.itemIds.add(item.id);
		if (completeChain) chain.complete = true;
	};

	const addProducer = (item) => {
		if (!item.id || item.energyCost <= 0 || item.createData.length === 0)
			return;
		const counts = new Map();
		for (const outputId of item.createData)
			counts.set(outputId, (counts.get(outputId) || 0) + 1);
		producers.set(item.id, {
			itemId: item.id,
			chainId: item.chainId,
			level: item.level,
			energyCost: item.energyCost,
			sampleSize: item.createData.length,
			drops: [...counts.entries()].map(([itemId, count]) => ({
				itemId,
				count,
				probability: count / item.createData.length,
			})),
		});
	};

	for (const snapshot of snapshots) {
		const data = fieldsOf(
			fieldsOf(snapshot.focusedControllers?.selectedItem?.view)._data,
		);
		const chainData = fieldsOf(data.chainData);
		const chainId = chainData.id == null ? null : String(chainData.id);
		if (chainId) {
			if (!chains.has(chainId))
				chains.set(chainId, {
					id: chainId,
					titleKey: null,
					maxLevel: null,
					complete: false,
					itemIds: new Set(),
					observedNames: new Set(),
					sourceFiles: new Set(),
				});
			const selectedName = snapshot.gameplayState?.selectedItemUi?.name;
			if (selectedName) chains.get(chainId).observedNames.add(selectedName);
			if (snapshot.__captureFile)
				chains.get(chainId).sourceFiles.add(snapshot.__captureFile);
			Object.assign(chains.get(chainId), {
				titleKey: chainData.Title ?? null,
				maxLevel: Number(chainData.MaxLv ?? 0) || null,
				complete: true,
			});
		}
		for (const value of arrayItems(data.chainItemDatas)) {
			const item = normalizeItem(value);
			addItem(item, true);
			addProducer(item);
		}
		for (const field of ["sourceItemDatas", "produceItemDatas"]) {
			for (const value of arrayItems(data[field])) {
				const item = normalizeItem(value);
				addItem(item, false);
				addProducer(item);
			}
		}
	}

	for (const producer of producers.values()) {
		for (const drop of producer.drops) {
			const item = items.get(drop.itemId);
			Object.assign(drop, {
				chainId: item?.chainId ?? null,
				level: item?.level ?? null,
				baseUnits: item?.baseUnits ?? null,
			});
		}
	}

	const normalizedChains = [...chains.values()]
		.map((chain) => {
			const chainItems = [...chain.itemIds]
				.map((id) => items.get(id))
				.filter(Boolean)
				.sort((a, b) => a.level - b.level);
			const observedMax = chainItems.at(-1)?.level ?? 0;
			return {
				id: chain.id,
				titleKey: chain.titleKey,
				minLevel: chainItems[0]?.level ?? null,
				maxLevel: chain.maxLevel ?? observedMax,
				observedMaxLevel: observedMax,
				complete: !!chain.complete && chainItems.length === chain.maxLevel,
				observedNames: [...(chain.observedNames || [])],
				sourceFiles: [...(chain.sourceFiles || [])],
				minItemId: chainItems[0]?.id ?? null,
				maxItemId:
					chainItems.find((item) => item.level === chain.maxLevel)?.id ?? null,
				itemIds: chainItems.map((item) => item.id),
			};
		})
		.sort((a, b) => a.id.localeCompare(b.id));

	return {
		generatedAt: new Date().toISOString(),
		rules: {
			mergeArity: 2,
			levelRule: "2 × level n -> 1 × level n+1",
			baseUnitsFormula: "2^(level-1)",
		},
		coverage: {
			completeChains: normalizedChains
				.filter((chain) => chain.complete)
				.map((chain) => chain.id),
			incompleteChains: normalizedChains
				.filter((chain) => !chain.complete)
				.map((chain) => chain.id),
			producerConfigurations: producers.size,
		},
		chains: normalizedChains,
		items: [...items.values()].sort(
			(a, b) => a.chainId.localeCompare(b.chainId) || a.level - b.level,
		),
		producers: [...producers.values()].sort((a, b) =>
			a.itemId.localeCompare(b.itemId),
		),
	};
}

function main(argv = process.argv.slice(2)) {
	const captureDir = path.resolve(argv[0] || "captures");
	const output = path.resolve(
		argv[1] || path.join(captureDir, "item-catalog.json"),
	);
	const files = fs
		.readdirSync(captureDir)
		.filter((file) => /\.json$/i.test(file))
		.sort();
	const snapshots = [];
	for (const file of files) {
		try {
			const snapshot = JSON.parse(
				fs.readFileSync(path.join(captureDir, file), "utf8"),
			);
			snapshot.__captureFile = file;
			const data = fieldsOf(
				fieldsOf(snapshot.focusedControllers?.selectedItem?.view)._data,
			);
			if (fieldsOf(data.chainData).id && arrayItems(data.chainItemDatas).length)
				snapshots.push(snapshot);
		} catch (_) {
			/* Ignore reports and incomplete captures. */
		}
	}
	const catalog = buildCatalog(snapshots);
	fs.writeFileSync(output, JSON.stringify(catalog, null, 2) + "\n", "utf8");
	console.log(`Item catalog written: ${output}`);
	console.log(
		`Complete chains: ${catalog.coverage.completeChains.join(", ") || "none"}`,
	);
	console.log(
		`Incomplete chains: ${catalog.coverage.incompleteChains.join(", ") || "none"}`,
	);
	console.log(
		`Producer configurations: ${catalog.coverage.producerConfigurations}`,
	);
	return catalog;
}

if (require.main === module) main();

module.exports = { buildCatalog, normalizeItem, decodeSnapshotString };
