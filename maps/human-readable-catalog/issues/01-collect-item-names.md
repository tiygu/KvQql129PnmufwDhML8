# Active scan 全量采集物品名称

标签: `wayfinder:task`

父级: [人类可读的图鉴审核](map.md)

## Question

如何让所有已知物品都有中文名字？

## Context

- Active scan 已经能逐个选中棋盘上的物品并捕获数据
- 选中物品时，`gameplayState.selectedItemUi.name` 提供中文名字（如 "双耳提包 5级"）
- `captureCatalogFromRuntime` 已经拿了 `selectedItemUi`，但只用来校验，没存名字
- `build-item-catalog.cjs` 的 `normalizeItem()` 提取了 12 个字段但没有 `name`
- 数据库 `item-identity` 的 payload 里没有 `name` 字段
- `catalog-review-gate.js` 的 `identityPayload()` 不包含 `name`

## 需要改的地方

1. `build-item-catalog.cjs` `normalizeItem()`：接收并传递 `name` 字段
2. `captureCatalogFromRuntime`：把 `selectedItemUi.name` 传给 `buildCatalog`（或让 buildCatalog 从 snapshot 中自己取）
3. `automation-database.js` `importCatalog`：把 `name` 存到 item-identity 的 payload 里
4. `catalog-review-gate.js` `identityPayload()`：包含 `name` 字段
5. 提供一条命令，对棋盘上所有物品跑一次 active scan，逐个选中、采集名字
