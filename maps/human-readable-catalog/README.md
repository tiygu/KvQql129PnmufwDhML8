# 人类可读的图鉴审核

标签: `wayfinder:map`

## Destination

图鉴审核界面能让一个正常人看懂：每个物品显示它的中文名字、图标、所属合成链，以及各项参数的含义和数值；操作员能审核并修改物品参数。不需要背 ID 对照表。

## Notes

- 领域：迷你游戏合成图鉴（merge game item catalog）
- 相关技能：`/prototype`（界面原型）、`/grilling`（决策梳理）
- 游戏引擎：Cocos Creator，通过 CDP runtime 读取
- 名字来源：`gameplayState.selectedItemUi.name`（选中物品时游戏提供）
- 其他参数来源：`selectedItem.view._data.chainItemDatas[].fields`（选中物品时游戏提供全部物品配置）
- Active scan 已能逐个选中物品并捕获数据，只需扩展它采集的字段

## Decisions so far

<!-- 每个已关闭的 ticket 一行 -->

## Not yet specified

- 审核界面原型长什么样（等物品名字和参数都能看到了再设计）
- 参数编辑的交互方式（在表格里改？表单？直接改 JSON？）
- 是否需要合成链图谱视图（树状图/流程图展示整条链的物品关系）

## Out of scope

- 游戏内物品配置的实际修改（只读审核 + 本地数据库修改，不碰游戏服务端）
- 自动翻译/本地化（名字直接用游戏提供的中文）
- 图标采集流程改进（已有 icon evidence service，本次不改）

## Open tickets

1. [全量采集物品名称](issues/01-collect-item-names.md) — `wayfinder:task`
2. [扩展数据管道采集游戏物品全部参数](issues/02-extend-item-fields.md) — `wayfinder:task`
