# 扩展数据管道采集游戏物品全部参数

标签: `wayfinder:task`

父级: [人类可读的图鉴审核](map.md)

## Question

游戏提供了每个物品的完整配置参数，但只有一小部分被采集。还缺哪些？怎么补？

## Context

选中物品时，游戏 `view._data.chainItemDatas[].fields` 提供每个物品的完整配置。
以 "口袋镜 1级" (10100076) 为例：

**已采集的：**

| 游戏字段 | 当前存储 |
| ---------- | ---------- |
| `id` | itemId |
| `Level` | level |
| `MergeChain` | chainId |
| `MergeTarget` | mergeTarget |
| `IconRes` | iconResourceIdentifier |
| `Price` | saleValue |
| `EnergyCost` | energyCost |

**未采集但游戏提供的：**

| 游戏字段 | 含义 |
| ---------- | ------ |
| `Describe` | 描述文本的 key（如 `item_intro_10100076`） |
| `CoinValue` | 出售金币价值 |
| `EnergyValue` | 能量价值 |
| `Value` | 综合价值分 |
| `BubbleOdds` | 气泡出现概率 |
| `BubblePrice` | 气泡售价 |
| `BubbleItem` | 气泡物品 ID |
| `Scissors` | 拆分还原目标（剪刀） |
| `AllMerge` | 多合一合成目标 |
| `IsDouble` | 是否双倍产出 |
| `IsHourglass` | 是否沙漏物品 |
| `SaleRemind` | 出售提醒标记 |
| `CDTime` | 生产冷却时间 |
| `FillNum` / `StoreNum` | 填充/存储数量 |
| `IconTips` | 图标提示等级 |
| `LuckyChance` / `luckyChance` | 幸运概率 |

还有 chain 级别的字段也未采集：`SortItem`（排序）、`CollectionShow`（是否在图鉴展示）、`LabelShow`（是否显示标签）。

## 需要改的地方

1. `build-item-catalog.cjs` `normalizeItem()`：加上未采集的字段
2. `automation-database.js` `importCatalog`：扩展 item-identity payload 字段
3. `catalog-review-gate.js` `identityPayload()`：包含新字段
4. 决定哪些字段需要进审核流程（比如 BubblePrice 也许不需要），哪些只读展示
