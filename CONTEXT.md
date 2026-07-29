# Mini Game Automation

This context describes the concepts exposed to operators who inspect and automate a connected mini game.

## Language

**Frontend Control Console（前端控制台）**:
A browser-based operator interface for observing the connected game, configuring automation, and issuing control actions.
_Avoid_: Electron APP、桌面端、安装包

**Automation Runtime（自动化运行时）**:
The long-lived process that connects to the game, collects state, plans actions, executes controls, and persists operational data independently of any open console page.
_Avoid_: 前端进程、Electron 主进程

**Automation Session（自动化会话）**:
The single active unit of automation work shared by every connected frontend control console.
_Avoid_: 浏览器会话、标签页任务

**Connection Route（连接路线）**:
The WMPF/CDP bridge that becomes available before the target game opens and carries runtime control traffic after the game connects.
_Avoid_: 前端连接、控制台服务器

**Foreground Launcher（前台启动器）**:
由当前 Windows 终端拥有的完整程序进程树。启动器会先清理同项目遗留进程，随后以前台方式运行控制服务；运行时与连接路线日志同时写入终端和日志文件，Ctrl+C、关闭终端或终止主进程都会结束受管子进程并释放端口。
_Avoid_: 后台启动器、仅打开网页、复用无终端归属的遗留服务

**Automation Launch State（自动化启动态）**:
操作者确认启动后、服务端首个运行状态到达前的短暂前端状态。所有自动化入口必须立即显示运行中的红色样式和暂停语义，启动请求失败时再回滚为待命，避免规划时间窗造成重复点击。
_Avoid_: 等待首次规划完成后才更新按钮、仅显示启动提示文字

**Display Icon Selection（展示图标选择）**:
从一个 **Item Identity** 的 **Item Icon Evidence** 候选中指定当前展示偏好的可追溯决定。它独立于 **Catalog Review Resolution**，更换或撤销时不改变物品的语义事实或规划资格。
_Avoid_: 图标字段裁决、完整身份确认、图标候选选择

**Icon Harvest Job（图标采集任务）**:
操作者为一个 **Item Identity** 或一条已冻结成员范围的合成链请求的有界图标采集工作。它汇总每个物品的采集结果，但不拥有 **Item Icon Evidence**，也不改变 **Display Icon Selection** 的人工优先级。
_Avoid_: 单物品图标任务、合成链图标任务、后台图标扫描

**Item Icon Acquisition（物品图标采集单元）**:
一个 **Icon Harvest Job** 中针对单个 **Item Identity** 的独立采集结果边界；多个任务可以共享同一来源契约下的在途采集，但各自保留自己的结果与取消语义。
_Avoid_: 图标文件、图标候选、合成链任务

## Relationships

### Item knowledge

**Catalog Observation（图鉴观测）**:
从当前游戏状态采集到、但尚未经过人工确认的物品或产出关系记录。
_Avoid_: 新物品、未知物品

**Active Catalog Entry（生效图鉴条目）**:
达到自动推断置信条件或经过人工裁决，当前可以参与规划的物品、合成链或产出关系。
_Avoid_: 已记录物品、可信 ID、已验证条目

**Human-Verified Entry（人工确认条目）**:
经过人工明确批准、其裁决优先于所有自动推断结果的图鉴条目。
_Avoid_: 手工数据、白名单条目

**Human Catalog Ruling（人工图鉴裁决）**:
针对单个图鉴字段或整个条目作出的可追溯、可撤销且优先于算法结果的人工决定。
_Avoid_: 手工覆盖、人工配置

**Catalog Review Resolution（图鉴审核结论）**:
针对一个图鉴对象的 **Complete Catalog Semantic Snapshot** 作出的人工审核结果；可以原样确认候选，也可以在修改完整语义快照后确认，并使该对象成为 **Human-Verified Entry**。
_Avoid_: 单字段保存、局部确认

**Complete Catalog Semantic Snapshot（完整图鉴语义快照）**:
一个图鉴对象在自身边界内拥有的全部语义事实。“完整”指该对象的语义边界完整，不包含证据、展示偏好、处置状态或审计元数据。
_Avoid_: 完整数据库记录、完整对象状态、含证据快照

**Catalog Evidence Hierarchy（图鉴证据层级）**:
解决冲突时依次信任人工裁决、运行时结构化配置、真实动作观测、结构推断和视觉识别的默认次序。
_Avoid_: 置信度排名

**Observed Entry（已观测条目）**:
仅确认在游戏状态中出现过、尚不足以参与规划的图鉴条目。
_Avoid_: 未知条目

**Provisional Entry（暂定条目）**:
已有算法推断、可以用于预览和模拟但尚不驱动真实操作的图鉴条目。
_Avoid_: 半可信条目、候选条目

**Semantic Review Reason（语义审核原因）**:
因对象含义、候选变化或证据冲突而需要人工判断的审核原因，其消除是完成图鉴语义审核的条件。
_Avoid_: 图标缺口、资料不完整

**Human-Readable Review Reason（人话审核原因）**:
面向操作者解释审核需求的自然语言说明，依次说明发生了什么、影响什么、需要核对什么；非阻塞的完整性缺口应明确说明不影响当前规划。诊断代码、置信度和证据编号不属于默认说明。
_Avoid_: 错误码、诊断代码列表、原始异常消息

**Meaningful Catalog Difference（有意义的图鉴差异）**:
会改变图鉴对象含义或规划结果的候选变化。审核工作台只默认显示这类变化，并以名称、等级、合成结果、单次体力、可能产出等领域语言表达；不变字段和纯技术元数据不进入默认差异区。
_Avoid_: JSON diff、全字段对比、元数据变更

**Catalog Relationship Sentence（图鉴关系句）**:
以“由什么合成”、“可合成为何物”、“由什么产出”、“用于哪个订单”或“属于哪条合成链”等自然语言描述关联对象的可点击表达。缺少可靠名称时使用带等级的“未命名物品”占位；沿关系切换审核焦点不构成对关联对象的确认。
_Avoid_: 关联 ID、外键、对象引用

**Catalog Completeness Gap（图鉴完整性缺口）**:
不改变对象含义、但仍有待补充的辅助资料缺口，例如尚未取得的 **Item Icon Evidence**；它不阻止对象生效或完成语义审核。
_Avoid_: 语义冲突、审核阻塞

**Catalog Review Queue（图鉴审核队列）**:
至少存在一个 **Semantic Review Reason**、等待人工检查、修正、暂停或否决的图鉴对象集合；仅有 **Catalog Completeness Gap** 的对象不进入该队列。
_Avoid_: 未知 ID 列表、错误列表、图标待补采列表

**Catalog Review Workspace（图鉴审核工作台）**:
供单个项目操作者理解候选图鉴知识、核对证据并作出 **Catalog Review Resolution** 的专用界面。默认呈现支持审核决定的领域信息，内部字段、原始载荷和诊断元数据仅作为按需展开的技术详情；它不是面向普通玩家的收藏图鉴。
_Avoid_: 玩家图鉴、数据库编辑器、JSON 审核页

**Catalog Object Display Title（图鉴对象展示标题）**:
审核工作台中供操作者辨认对象的首要名称。按“已确认名称”、“疑似‘候选名称’”、“未命名物品”逐级降级；内部 ID 不进入标题，同名对象优先使用图标、等级和合成链位置等领域线索区分。
_Avoid_: 内部 ID 标题、未知 ID、对象键

**Catalog Review Action Status（图鉴审核行动状态）**:
面向操作者表达下一步动作的审核状态：“需要处理”、“等待更多线索”、“已确认”、“已跳过”或“资料待补充”。证据阶段不充当行动状态，仅在技术详情中展示。
_Avoid_: observed、provisional、active、数据库状态

**Catalog Review Information Boundary（图鉴审核信息边界）**:
审核工作台默认区只呈现完成当前裁决所需的最小充分信息：对象身份、行动状态、人话审核原因、有意义的差异、相关证据摘要、关系及修改结果。内部标识、原始载荷、诊断元数据、完整证据历史、算法评分、不变字段和无关元数据只在技术详情中展示；成为裁决依据时也应先生成自然语言摘要。
_Avoid_: 默认展开技术详情、完整记录表单、原始数据优先

**Ordinary Catalog Review Action（普通图鉴审核操作）**:
只针对当前图鉴对象的 **Complete Catalog Semantic Snapshot** 作出确认、修改后确认或暂时跳过，不直接改变对象是否参与规划、证据历史的解释方式或领域校验规则。
_Avoid_: 证据投票、诊断操作、原始数据编辑

**Advanced Catalog Diagnostic Action（高级图鉴诊断操作）**:
会改变图鉴对象是否参与规划、改变冲突证据的解释方式，或绕过领域表单校验直接编辑原始数据的诊断操作。
_Avoid_: 普通审核、更多审核操作

**Catalog Object Suspension（图鉴对象暂停）**:
一种持久的高级诊断隔离状态；保留对象现有裁决与证据，但阻止该对象参与规划，直到操作者明确恢复。暂停前应说明受影响的订单或关系并要求确认。
_Avoid_: 暂时跳过、删除对象、否决证据

**Catalog Evidence Disposition（图鉴证据处置）**:
针对单条冲突证据作出的高级诊断判断。采用证据会将其标为可信裁决依据并把相应值带入领域表单，但仍需单独确认 **Complete Catalog Semantic Snapshot**；否决证据会保留其历史与来源，同时将其排除在后续自动推断之外。
_Avoid_: 对象裁决、删除证据、证据投票

**Advanced Catalog Snapshot Edit（图鉴快照高级编辑）**:
在默认只读的技术详情中显式开启原始 JSON 编辑，经结构、引用和领域不变量校验后，将变化翻译为人话差异与影响范围，并由操作者再次确认后提交 **Complete Catalog Semantic Snapshot**。它可以编辑领域表单未暴露的字段，但不能绕过核心数据完整性。
_Avoid_: 直接写库、无校验 JSON 保存、普通字段编辑

**Catalog Audit Summary（图鉴审计摘要）**:
系统根据操作上下文自动生成的可读审计记录，说明谁在何时对哪个对象做了什么、有意义的前后差异、触发操作的人话原因、对规划及关联对象的影响，以及采用或处置的证据。内部标识和原始载荷只保留在审计详情中。
_Avoid_: 强制审核备注、原始事件日志、JSON 差异

**Catalog Review Gate（图鉴审核闸门）**:
只允许满足当前生效条件的 **Active Catalog Entry** 参与规划，并服从人工裁决的领域规则。
_Avoid_: 人工模式、手动白名单

**Item Identity（物品身份）**:
一个物品 ID 所指代的领域对象，以名称、等级、类型等语义事实与其他物品区分。图标证据支持人工辨认，但 **Display Icon Selection** 不属于它的语义事实。
_Avoid_: 物品配置、物品资料、展示图标选择

**Merge Relation（合成关系）**:
两个同级物品合成为下一等级物品的链内关系。
_Avoid_: 合成物、合成配置

**Production Profile（产出档案）**:
一个产出物总体能够产出哪些候选物、具备哪些可用产出档位的记录。它可以汇总各档位信息，但不拥有具体档位的单次体力成本和产物分布；档位集合变化导致候选产物集合变化时，档案需要独立复核。
_Avoid_: 产出物配置、掉落表

**Theoretical Production Distribution（理论产出分布）**:
从运行时结构化配置提取、作为概率推断先验而不冒充真实样本的产出分布。
_Avoid_: 配置样本、真实概率

**Observed Production Distribution（观测产出分布）**:
由可归因的真实产出动作逐步积累的结果分布。
_Avoid_: 配置概率、理论概率

**Planning Production Distribution（规划产出分布）**:
融合理论先验和真实观测、供规划器进行保守决策的当前概率模型。
_Avoid_: 最终概率、真实概率

**Production Mode（产出档位）**:
同一产出物可切换的一种具体产出选择，拥有自己的单次体力成本与产物分布；对档位的裁决不隐含确认所属产出档案。
_Avoid_: 产出物等级、合成物消耗

**Bounded Automation Session（有界自动化会话）**:
以完成一个订单或到达明确等待边界为目标、不会长期等待体力恢复的自动化会话。
_Avoid_: 单步模式

**Idle Automation Session（挂机自动化会话）**:
体力不足时按运行时恢复信息休眠并在唤醒后重新读取和规划、持续到人工停止或不可恢复阻塞的自动化会话。
_Avoid_: 无限循环、后台轮询

**Specified Order Strategy（指定订单策略）**:
只为人工指定的订单执行完整路径规划；仅当该订单已经消失或没有可执行动作时，才按普通优先级选择并完整规划下一个订单。
_Avoid_: 同时完整规划所有订单、仅改变最终排序

**Item Icon Evidence（物品图标证据）**:
用于人工辨认 **Item Identity** 的真实游戏图像及其来源记录，不是条目参与规划的必要条件。
_Avoid_: 图标配置、物品身份

**Item Icon Evidence Currency（物品图标证据时效）**:
一条 **Item Icon Evidence** 的显式来源契约是否仍被当前采集策略接受；只由采集器、重建版本和质量契约版本判定。不可变来源契约是事实，最近一次策略评估是可重新计算的持久投影；过期证据继续保留其图像、来源和审计，只退出后续自动选择资格。
_Avoid_: 按创建时间猜测、按像素外观猜测、删除旧图标

**Item Icon Evidence Lineage（物品图标证据谱系）**:
同一 **Item Identity** 的多次图标采集之间可追溯的替代关系。同一来源的版本演进由稳定采集身份关联；不同来源的当前合格证据也可替代留下自动选择空缺的过期证据，但不会覆盖人工展示偏好。
_Avoid_: 覆盖旧候选、要求同一来源才能替换、按文件哈希推断来源

**Merge-Chain Icon Harvest（合成链图标采集）**:
针对一条已验证合成链，从当前已加载的运行时纹理中为全部 **Item Identity** 批量提取 **Item Icon Evidence**；该操作不产生棋盘动作，尚未加载的资源保留为明确的待补采项。
_Avoid_: 自动合成采图、逐个点击采图

**Passive Catalog Collection（被动图鉴采集）**:
不产生游戏动作、仅从当前状态和既有动作结果中积累图鉴证据的采集方式。
_Avoid_: 后台扫描

**Active Catalog Scan（主动图鉴扫描）**:
在安全边界内通过选择物品或切换界面获取额外图鉴证据的受控操作。
_Avoid_: 自动点击、自动识别

**Catalog Evidence Block（图鉴证据阻塞）**:
订单因所需图鉴知识尚未达到生效条件而暂时不能形成可信操作计划的状态。
_Avoid_: 无可行订单、无产出步骤

**Board Space Feasibility（棋盘空间可行性）**:
在当前棋盘与仓库容量下完成产出和中间合成而不陷入空间死锁的能力。
_Avoid_: 空格数量、棋盘容量

**Item Opportunity Value（物品机会价值）**:
物品因订单需求、重建成本、链内稀缺性、出售收益和空间占用共同形成的保留价值。
_Avoid_: 物品售价、物品价值

**Map Progress Coins（地图推进金币）**:
通过订单或出售获得、其当前用途是满足地图任务要求的金币资源。
_Avoid_: 可支配预算、仓库解锁货币

**Sale Policy（出售策略）**:
规定哪些剩余物品可以被建议、确认或自动出售的人工优先规则与安全条件。
_Avoid_: 出售开关

**Warehouse Inventory Knowledge（仓库清单知识）**:
程序对仓库具体槽位和物品内容是否已经加载的认知状态。
_Avoid_: 仓库容量、仓库状态

**Warehouse Store Availability（仓库存入可用性）**:
游戏原生预检对某个具体棋盘物品能否存入以及目标仓库槽位的判定。
_Avoid_: 仓库是否加载、仓库有空位

**Warehouse Retrieval（仓库取回）**:
在仓库界面点击指定槽位物品、由游戏把它放回任意合法棋盘空格的可验证动作。
_Avoid_: 仓库拖拽、指定格取回

- A **Frontend Control Console** observes and controls exactly one **Automation Runtime** through its control interface.
- The **Frontend Control Console** contains the shared catalog review workspace; it is not a separate catalog-management application.
- One **Automation Runtime** may be controlled by multiple **Frontend Control Consoles**.
- An **Automation Runtime** has at most one active **Automation Session**.
- An **Automation Runtime** continues operating when no **Frontend Control Console** page is open.
- An **Automation Runtime** may manage its own **Connection Route** or reuse one started externally.
- A **Catalog Observation** may enter the **Catalog Review Queue** without blocking an algorithmically inferred version from becoming an **Active Catalog Entry**.
- A **Catalog Review Gate** admits algorithmically inferred entries only when they satisfy its confidence rules.
- A new entry progresses from **Observed Entry** to **Provisional Entry** and then **Active Catalog Entry** as object-specific evidence conditions are satisfied.
- **Item Identity**, **Merge Relation**, **Production Profile**, and **Production Mode** have independent evidence conditions and may reach different states at different times.
- Missing **Item Icon Evidence** is tracked as a data-completeness gap and does not by itself prevent an otherwise qualified entry from becoming active.
- A **Catalog Completeness Gap** does not create a **Semantic Review Reason** and does not keep an otherwise resolved object in the **Catalog Review Queue**.
- A **Catalog Review Resolution** applies to exactly one **Item Identity**, **Merge Relation**, **Production Profile**, or **Production Mode** and never verifies a related object implicitly.
- A **Catalog Review Resolution** commits exactly one **Complete Catalog Semantic Snapshot** and never includes **Display Icon Selection**, evidence records, completeness state, disposition, or audit metadata.
- An **Ordinary Catalog Review Action** only confirms, modifies and confirms, or temporarily skips the current **Complete Catalog Semantic Snapshot**; it never changes evidence interpretation or bypasses domain validation.
- An **Advanced Catalog Diagnostic Action** is required to change planning participation, dispose of conflicting evidence, or edit raw data outside the domain form.
- “暂时跳过” only moves the object later in the current review queue and does not change its active data or planning eligibility.
- A **Catalog Object Suspension** persists across review sessions, preserves the current ruling and evidence, and removes the object from planning until explicitly resumed.
- A **Catalog Evidence Disposition** never confirms the containing object: adopting evidence only prepares a candidate snapshot, while rejecting evidence excludes it from future inference without deleting its history or changing an existing object ruling.
- An **Advanced Catalog Snapshot Edit** remains subject to structural, referential, and core domain-integrity validation and becomes a ruling only after a human-readable impact preview receives explicit confirmation.
- A **Catalog Audit Summary** is generated for every review or diagnostic action without requiring a manual note; it records the action, meaningful differences, triggering review reason, planning impact, replanning result, and evidence references.
- Ordinary confirmation, modified confirmation, temporary skipping, resuming an object, and adopting evidence do not add a second confirmation step.
- Suspending an object, rejecting evidence, and applying an **Advanced Catalog Snapshot Edit** require an impact preview and explicit second confirmation.
- A human may append an optional explanation to modified or advanced actions, but cannot replace or rewrite the system-generated **Catalog Audit Summary**.
- “确认候选” accepts the current **Complete Catalog Semantic Snapshot** as the **Catalog Review Resolution** for that object.
- “保存修改” accepts the modified **Complete Catalog Semantic Snapshot** as the **Catalog Review Resolution** for that object.
- A resolved object leaves the **Catalog Review Queue** when no **Semantic Review Reason** remains, even when it still has a **Catalog Completeness Gap**.
- A genuine evidence conflict remains a **Semantic Review Reason** until the conflicting evidence has received an explicit human disposition; the disposition does not discard its evidence history.
- An **Item Identity** may have multiple **Item Icon Evidence** candidates from runtime resources, screenshots, or manual input, while one candidate may have a **Display Icon Selection**.
- A **Display Icon Selection** has its own audit history, may satisfy an icon **Catalog Completeness Gap**, and never confirms an **Item Identity** or resolves its **Semantic Review Reason**.
- An **Item Icon Evidence** summary expresses two independent facts: **Item Icon Evidence Currency** as current or stale, and **Display Icon Selection** as manual, automatic, or absent.
- A stale **Item Icon Evidence** summary explains the operational consequence—excluded from automatic display selection while its image and history remain—without exposing provenance-policy versions by default.
- “Superseded” describes an **Item Icon Evidence Lineage** relationship rather than currency or selection state, so it appears only when lineage is examined.
- Only an explicit **Item Icon Evidence Lineage** edge makes evidence superseded; a new candidate, a rank change, or a **Display Icon Selection** change does not create that relationship.
- **Item Icon Evidence Lineage** may branch across sources and is represented by explicit replacement edges; acquisition time never creates or orders those edges implicitly.
- Stale **Item Icon Evidence** may remain the current display under a protected manual **Display Icon Selection**; that combination never changes the containing **Item Identity**.
- Replacing a manual **Display Icon Selection**, revoking it into a protected empty state, and explicitly returning selection to automatic control are three distinct display-icon decisions.
- Returning a **Display Icon Selection** to automatic control atomically removes manual protection and reevaluates existing current eligible evidence; an empty result remains eligible for later automatic filling and does not start an **Icon Harvest Job**.
- A human may deliberately create a protected **Display Icon Selection** from stale historical evidence after acknowledging that it remains ineligible for automatic selection; this does not change its currency or the containing **Item Identity**.
- Automatic **Display Icon Selection** requires current eligible evidence, while manual selection may use any retained evidence with a readable image asset after acknowledging stale or superseded status.
- A protected manual **Display Icon Selection** survives loss of its readable image asset: the selection remains explicit and unavailable for rendering until reacquisition or another human display-icon decision, without affecting **Item Identity** or planning eligibility.
- **Item Icon Evidence** is presented by operational role rather than as one identity-confidence ranking: the current **Display Icon Selection**, current eligible alternatives, and retained historical evidence are distinct groups.
- Default **Item Icon Evidence** presentation uses human-readable source, acquisition time, currency, selection state, and operational consequences; internal identifiers, provenance-policy versions, scores, hashes, and full audit history remain diagnostic detail.
- Diagnostic presentation keeps immutable **Item Icon Evidence** provenance, recomputable **Item Icon Evidence Currency** evaluation, **Item Icon Evidence Lineage**, and **Display Icon Selection** history in separate sections.
- Human-readable icon status always qualifies “current” by concept—current display versus current evidence currency—rather than using an unscoped “current” label.
- Human-readable **Display Icon Selection** audit summaries state the event and operational consequence; candidate identifiers, provenance-policy versions, and lineage-edge identifiers remain in audit detail and never enter **Item Identity** review history.
- **Item Icon Evidence Currency** is derived from explicit provenance contracts; unversioned legacy runtime-resource evidence is stale, while screenshot and manual-upload evidence are not made stale merely because they lack a runtime reconstruction version.
- The latest **Item Icon Evidence Currency** evaluation is persisted with its policy version and is audited only when the status changes; schema migration and later policy reevaluation are idempotent metadata operations that do not read image bytes, connect to the runtime, or trigger harvesting.
- When stale **Item Icon Evidence** holds an automatic **Display Icon Selection**, the selection is cleared and audited until a current eligible candidate succeeds; a manual selection remains authoritative with a stale-evidence warning, and a manual revocation continues to block automatic selection.
- Any current eligible **Item Icon Evidence** for the same **Item Identity** may fill an automatic-selection gap left by stale evidence, regardless of source; **Item Icon Evidence Lineage**, candidate persistence, automatic selection, and their audit records change atomically, while manual preferences remain unchanged.
- **Item Icon Evidence** is acquired on demand for a specific **Item Identity**; the page resource tree is evidence discovery input rather than a catalog of item identities.
- A **Merge-Chain Icon Harvest** extracts already loaded runtime assets without selecting, synthesizing, or moving board items; unloaded chain members remain explicit icon gaps that can be retried later.
- **Passive Catalog Collection** may run during automation, while an **Active Catalog Scan** may run only outside action execution or at an explicit safe boundary.
- A **Catalog Evidence Block** applies to an individual order; other orders with sufficient active knowledge remain eligible for automation.
- When every order has a **Catalog Evidence Block**, the automation session enters a recoverable evidence-waiting state and replans after new evidence becomes active.
- Automation planning applies lexicographic priorities: safety, **Board Space Feasibility**, order and map progress, **Item Opportunity Value**, then safe surplus-sale return.
- A **Specified Order Strategy** fully plans one order at a time: the selected order first, then one fallback order only after the selected order disappears or has no executable action.
- **Map Progress Coins** are optimized toward the current map-task requirement and are not reserved for warehouse-slot unlocking, which uses a different resource.
- A warehouse slot exchanges finite warehouse capacity for board operating space; it does not create free capacity.
- **Warehouse Inventory Knowledge** and **Warehouse Store Availability** are independent: an unloaded inventory may still admit a specifically preflighted store action.
- A **Warehouse Retrieval** does not predict its destination grid; it verifies the actual landing position and replans before any dependent merge.
- A **Warehouse Retrieval** normally preserves one board buffer space, except when the retrieved item can be verified and immediately merged after landing.
- In the first delivery, a **Sale Policy** may produce observation-mode recommendations and assisted-mode confirmed actions, while automatic surplus selling remains an explicitly enabled later capability.
- A **Sale Policy** recommends selling only to close the current **Map Progress Coins** deficit or to resolve board-space pressure that safe merging and warehouse storage cannot resolve.
- A **Human-Verified Entry** overrides conflicting automated inference and remains authoritative until a human changes that decision.
- A **Catalog Review Resolution** addresses every field in its accepted snapshot, while a field-level **Human Catalog Ruling** addresses only its named fields.
- A **Human Catalog Ruling** locks only the fields it addresses; unrelated fields continue accumulating evidence and may progress independently.
- Conflicting automated evidence creates a review alert rather than replacing a **Human Catalog Ruling**.
- Revoking a **Human Catalog Ruling** reveals the current evidence-derived candidate instead of restoring a stale historical value.
- The **Catalog Evidence Hierarchy** resolves ordinary conflicts, while theoretical production probabilities and observed production probabilities remain separate evidence series.
- A **Production Profile** retains separate **Theoretical Production Distribution** and **Observed Production Distribution** evidence and derives a replaceable **Planning Production Distribution** from both.
- A producer has one or more **Production Modes**, and each mode owns an independent **Production Profile** rather than sharing probabilities by producer ID alone.
- Planning may switch between active **Production Modes** after verifying the resulting mode, unless a **Human Catalog Ruling** pins the producer to a specific mode.
- A **Bounded Automation Session** ends instead of waiting for energy recovery, while an **Idle Automation Session** sleeps without polling and replans from fresh state after waking.
- In automatic mode, the **Frontend Control Console** primary start action creates an **Idle Automation Session** so successful order submission and recoverable energy depletion do not reset the start button; single-step and explicit `maxActions` requests remain **Bounded Automation Sessions**.
- An **Idle Automation Session** exists only for the lifetime of its **Automation Runtime**; runtime restart ends the session and does not persist an intent to resume.
- Observation mode may present expected and uncertain outcomes, assisted mode replans from posterior expectations after each confirmed step, and automatic mode uses conservative feasibility estimates without exposing probability-tuning controls in the first release.
- A rejected or superseded observation remains available as evidence but is not active planning knowledge.
- **Item Identity**, **Merge Relation**, **Production Profile**, and **Production Mode** are reviewed independently; accepting one never implicitly verifies any of the others.

## Example dialogue

> **Dev:** “关闭前端控制台页面后，自动化要停止吗？”
> **Domain expert:** “不要；自动化运行时独立运行，重新打开前端控制台后应恢复展示当前状态。”

## Flagged ambiguities

- “前端控制台管理”已明确为浏览器控制台，不是把现有页面重新包装成桌面 APP。
