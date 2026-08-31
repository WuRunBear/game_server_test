# Survival-Island 切片实施计划

> **状态：历史规划文档**（切片实施记录，原文保留不回改）；其中地图/刷怪相关表述（如 `game/spawns/populations.json`、zone 划分、出生点随图）为地图系统重设计前的历史，现状以 `docs/ROADMAP.md` 与源码为准。
>
> 本文件是 survival-island 游戏从"可玩 demo"到"完整游戏"的切片路线。**demo 阶段
> 落地核心七切片**（Slice 1-7），后续切片按需开启。
>
> 每个切片是一个垂直玩法切片，收尾三同步：可玩 demo 前进 + 框架增长通用系统 +
> 测试/文档同步。一个切片未完成不开启下一个（缺陷阻塞除外）。

## 已定型的技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| **demo 边界** | Slice 1-7 核心循环 | 生存+战斗+合成+昼夜+联机存档+建造场景切换+对话任务，约 20-30 分钟单局贯通 |
| **完整目标** | 核心 + 后续按需（成就/阵营/等级等） | demo 跑通后再评估是否继续 |
| **变长结构建模** | runtime AoS 数组 + spawn 初始化钩子 | Needs/ResourceNode/Inventory/ItemMeta/Intent 统一为 `[] as T[]` AoS，与现有 Kind/Inventory 先例一致；spawn 经组件注册表的 AoS 初始化钩子按 archetype 配置写入。**S1 已替代原 systemRuntimes Map 选型**（探查发现 Kind/Inventory 已是 AoS，统一一套机制更简；netSync 也据此统一适配） |
| **Inventory 模型** | slot 存 `{itemId, count}` + 容量走 archetype 配置 + 独立 `Equipment` 组件（weapon/tool/armor 三槽引用 inventory 槽） | 够支撑堆叠/容量/穿戴，不造格子拖拽引擎。客户端拖拽自便（**S1 落地**：slot `{kind,count}`，capacity 进 archetype，经 AoS 钩子初始化） |
| **服务端操作原子** | `equip/transfer/drop/consume/use` 作为 Inventory/Equipment 系统的对外接口 | 客户端 UI 调这些 RPC，服务端权威做数据变更与校验 |

> **后续对账注记（追加补充，不覆盖原文）**：`use` 原子**未落地**——按"即需即补"
> 无真实需求静默裁剪（equip 有 S3 明确记录推迟，use 遗漏了记录）。截至 S7，
> 实际命令原子为：consume / drop / transfer / craft(S3) / equip(S3) / place(S4) /
> deconstruct(S6) / dialogue(S7)。若未来出现"使用物品触发世界效果"（如点火、
> 开门）再补 use。

## 总原则（来自 AGENTS.md §AI 协作铁律，强制）

1. **铁律**：游戏逻辑永远不写进 `framework/`。每特性按序决策：① 先尝试纯 `game/*.json` 表达 → ② 缺能力在 `framework/` 加通用机制（类型名/参数游戏无关）→ ③ 扩展点表达不了时**先修扩展点**再写特性。
2. **通用的接口，最小的实现**：即需即补 ≠ 过度设计。只需状态机时不造 GOAP；只需 `(itemId,count)` 槽时不造格子拖拽。
3. **每切片收尾三同步**：demo 可玩前进 + 框架增长通用系统 + 测试/文档同步。验收统一以 `pnpm test` + `tsc --noEmit` + `pnpm tools validate` 全绿为准。
4. **游戏无关性 grep**：每切片收尾前 `rg -i "hunger|荒岛|wood|boar|berry|wolf" framework/` 必须空（游戏词只能在 `game/` 与 `src/register.ts`）。

---

## 跨切片前置：必须先修的扩展点

> 这些是"完整结构"能落地的真正前置，**按切片即时即补**，不提前批量造。

| 扩展点 | 现状 | 切片 | 修法 |
|--------|------|------|------|
| **Inventory 数据模型** | 4 固定槽存 eid，无堆叠 | S1 | slot 改 `{kind,count}` + 容量字段进 archetype（经 AoS 初始化钩子） |
| **AoS archetype 初始化** | spawn 只认 SoA，AoS 组件声明静默无效 | S1 | `componentRegistry` 加 `registerAosInitializer`，`spawn.ts` 按 `Array.isArray` 分支调钩子写入 `CompAoS[eid]` |
| **items 加载段** | 无 item kind 概念与目录 | S1 | `GameDefinitionSchema` 加 `items` 键 + `ItemKindSchema` + `loadItemsFile` + `itemsByKind` 索引（`game/items/*.json`） |
| **netSync** | `组件.标量字段` 清单；AND-query 排除缺组件的实体；线路仅 number | S1 | 三层改造：① OR 语义（逐条目独立查询合并）② AoS 适配器（`registerAosSyncAdapter` 按 tags 限定，展平 numbers/strings）③ `EntityState.stringValues` 字符串线路 |
| **SpawnSchema** | `{kind,zoneId,max,respawnMs}` | S4 ✅ | 加可选 `condition` 字段引用通用 condition 模块（spawnConditions 注册表，isNight 内建，夜刷狼用） |
| **RuleSchema** | 仅有 CombatRule（`.passthrough()`） | S1/S3/S4 | 加 `NeedsRuleSchema`（S1 已落地）/`CraftingRuleSchema`/`DayNightRuleSchema`；`ruleSchemas` 注册表已建（S1） |
| **BT 通用节点** | 已支持 action+condition | S2 | 在 `framework/ai/nodes/` 加通用 condition/action（IsTargetInVision/InAttackRange/Chase/Flee/Attack ✅ S2；IsNight/Sleep 属 S4）注册到 actionRegistry |
| **Persistence 接口** | stub | S5 | 补 `repository.ts` 实现 |

> **后续对账注记（追加补充，不覆盖原文）**：本表「现状」列为**写计划时的快照**，
> 修法侧的 ✅ 标记回填不完整。截至 S7 完成，表内 8 项扩展点**全部落地**：
> - Inventory 数据模型 / AoS archetype 初始化 / items 加载段 / netSync 三层改造 —— S1 完成
> - SpawnSchema.condition（spawnConditions 注册表 + isNight 内建）—— S4 完成（行内已标 ✅）
> - RuleSchema 族 —— **5 个注册 schema 已落地**：combat / needs / crafting / daynight /
>   server（ruleSchemas 注册表，S1 建表）；place 规则经 raw 透传
> - BT 通用节点 —— S2（IsTargetInVision/InAttackRange/Chase/Flee/Attack）+ S4
>   （IsNight/IsInLight/Sleep）完成
> - Persistence 接口 —— S5 完成（Repository/WorldRecord + createFileRepository 真实现）

---

## Slice 1 — 生存循环（"能活、会死"）✅ 已完成

**目标**：玩家有持续衰减的生理需求，需采集食物补给，否则死亡。

> **S1 实施修正（来自落地探查，写回此计划）**：
> - 变长结构统一走 AoS 数组 + spawn 初始化钩子（替代原 systemRuntimes Map 选型，见上表）
> - 跨切片前置表补 3 项 S1 真前置：items 加载段、AoS archetype 初始化、netSync 三处深层改造（OR 语义 / 字符串线路 / AoS 数据源）
> - `ResourceNode` 因字符串引用（yieldsKind）改为 AoS 形态（计划表原写 SoA）；
> - `equip` 原子按即需即补推迟到 Slice 3 有真实装备需求时再加，S1 不留空 stub。

### 新增框架组件（通用，游戏无关）

| 组件 | 形态 | 字段 | 备注 |
|------|------|------|------|
| `Kind` | AoS `string[]` | — | Phase 0 #2 已落地：`Kind[eid]` 存 archetype.kind 字符串，spawn 经 `setEntityKind` 写入；gathering/loot/perception 共用 |
| `Needs` | AoS `(Need[] \| undefined)[]` | `Need={name,current,max,decayPerSec,starveDmg}` | 变长；游戏侧填 `hunger`/`thirst` 名；经 `registerAosInitializer` 从 archetype 数组深拷贝；`callback?` 不存（consume 效果按 need 名匹配） |
| `ResourceNode` | AoS `(ResourceNodeState \| undefined)[]` | `remaining,max,amountPerHit,regenMs,yieldsKind,directConsume,depletedSinceMs` | `yieldsKind` 为 item kind **字符串**引用；`directConsume` 直接施放不入背包；`depletedSinceMs` 供再生记账 |

### 新增/扩展框架系统

| 系统 | 职责 | 状态 |
|------|------|------|
| `needDecaySystem` | 按 dt 衰减 Needs，过阈值掉 Health | 新增 |
| `gatheringSystem` | 玩家对 ResourceNode 交互：产出 item 入背包 + 节点 remaining-1 + regenMs 后再生 | 新增 |
| `interactionSystem` | 从"仅日志"路由交互意图（proximity + intent → 派发 gathering/equip/craft）| 扩展 |
| `inventorySystem` | 吞物品修复后顺势加：堆叠累加、容量上限校验、操作原子 equip/transfer/drop/consume | 扩展 |

### Inventory 操作原子（服务端权威）

作为 `inventorySystem` 对外接口（客户端 RPC 调用）：
- `transfer(fromSlot, toSlot)` — 背包内移动/合并
- `drop(slot)` — 丢到地面成 item 实体（`ItemMeta` 带 `pickupAfterMs` 防瞬回）
- `consume(slot)` — 食用：按 item.consume 效果名匹配恢复 Need + 消耗
- `equip(slot)` — **推迟到 Slice 3** 有真实装备需求时再加（S1 不留空 stub）

### game/ 配置

| 文件 | 内容 |
|------|------|
| `game/entities/player.json` | 加 `Needs:[{hunger,decay 0.5/s,starveDmg 1},{thirst,decay 0.7/s,starveDmg 1}]`、`Inventory{capacity:12}` |
| `game/entities/berry_bush.json` | ResourceNode：remaining 5, yields `berry`, regenMs 60000 |
| `game/entities/tree.json` | ResourceNode：yields `wood` |
| `game/entities/water_pool.json` | ResourceNode 特例：`directConsume` 直接补 Thirst（不入背包），remaining 9999 常驻 |
| `game/entities/item.json` | 通用 item 原型（落地产物用） |
| `game/items/berry.json` | item kind=berry, consume 回 Need(hunger,+20), maxStack 20 |
| `game/items/wood.json` | item kind=wood（材料，无 consume）, maxStack 50 |
| `game/items/water.json` | item kind=water（供 water_pool directConsume 引用）, consume 回 Need(thirst,+30) |
| `game/rules/needs.json` | 全局衰减倍率 `{decayScale}`；starveDmg 逐项放 player.json 的每个 Need 上 |
| `game/spawns/populations.json` | 资源节点初始布置（berry_bush 8 / tree 6 / water_pool 2） |
| `game/game.json` | `systems` 启用 needDecay/gathering/interaction(range 24)；`netSync.fields` 加 `Needs{tags:Player,name/current/max}`/`Inventory{tags:Player,slots}`/`ItemMeta{tags:Item,kind/count}`/`ResourceNode{tags:Resource,remaining}` |

### 测试点

- 单测：`needDecaySystem` 衰减 + 阈值扣 Health
- 单测：`gatheringSystem` 采集入背包 + 节点 remaining 递减 + 满包不入
- 集成快照：spawn 玩家 + 浆果丛，跑 N tick，断言"采集回复"与"饥饿致死"两条路径

### demo 里程碑

玩家走动寻浆果丛采集，饥饿/口渴条下降，吃浆果回血回饱；不补给则饿死。

---

## Slice 2 — 战斗闭环（"能打、有收益"）✅ 已完成

**依赖**：Phase 0 combat 射程、bt condition 已修。

> **S2 实施修正（来自落地探查，写回此计划）**：
> - `LootTable` 由计划的 "runtime Map" 改为 **AoS 数组 + spawn 初始化钩子**
>   （S1 已确立"变长结构统一 AoS"先例，可进 archetype 配置、spawn 自动写）
> - **combatSystem 重构为攻击原子**：原"范围内无差别自动攻击"与 BT 驱动战斗
>   冲突（双重伤害）且玩家无攻击入口；改为导出 `attackTarget` 原子（冷却/友伤/
>   射程/公式统一校验，不负责死亡），BT Attack 动作与玩家 attack 意图都调它，
>   系统体只递减冷却。参数从 `rules/combat.json` 读取，系统级 config 保留占位
> - **死亡统一归 deathSystem**：needDecaySystem 不再自行 removeEntity；
>   deathSystem 收编全部致死源（战斗/饿死），玩家分支写重生标记（原地重置：
>   同 networkId 免会话重绑，respawnSystem 重置 Health + 传送出生点 + Needs）
> - **重生规则**：`game/rules/respawn.json`（delayMs/resetNeeds）
> - BT 行为 JSON 用 mistreevous JSON 形态（selector/sequence/condition/action），
>   计划文中的 MDSL（`seq[...] else ...`）仅示意
> - `Perception` 按计划含 visionRadius + hostilityRange 双字段（hostilityRange
>   当前无消费方，字段先占位）
>
> **S2 审查修复（第二轮，写回此计划）**：
> - `IsTargetInVision` 必须 `!= null` 判定：perception 无目标时**写 null 而非不写 key**，
>   旧 `!== undefined` 在 set-null 时恒 true（rabbit 不逃不游荡的根因）
> - `Chase` 到位语义：进入攻击射程时返回 SUCCEEDED 并清零速度——mistreevous
>   sequence 中 RUNNING 子节点会卡住序列，Chase 恒 RUNNING 导致 InAttackRange/Attack
>   永不执行（敌追到射程内却永不攻击）
> - perception 可感知判定：排除 team 0（中立）与 Health ≤ 0（尸体/重生窗口）
> - 死亡/重生窗口玩家不接收输入不路由意图（applyInputs + interactionSystem 守卫）
> - deathSystem 已标记玩家不重复掷骰掉落；`game.json` 删除失效的 combat.config
> - aiSystem 对未注册 kind 的原型回退默认树（防手工 spawn NPC 时 tick 降级）
> - `Attack` 冷却中返回 RUNNING 保持接战（不再退回 Wander）

### 新增框架组件

| 组件 | 形态 | 字段 |
|------|------|------|
| `LootTable` | AoS `(LootEntry[] \| undefined)[]` + 初始化钩子 | `LootEntry={kind, qty, chance}` |
| `Perception` | SoA | `visionRadius, hostilityRange` |

### 新增/扩展框架系统

| 系统 | 职责 |
|------|------|
| `perceptionSystem` | 扫视野内敌对实体写黑板 `perception.target`（Chase/Flee/Attack 用），先于 aiSystem 执行 |
| `lootSystem` | **并入 deathSystem**（即需即补：死亡按 LootTable 掷骰 spawn item 实体，无需独立系统） |
| `deathSystem` | Health≤0 → 掉落 → removeEntity；玩家分支留重生标记（原地重置语义） |
| `respawnSystem` | 玩家死后到期重置 Health/位置/Needs（同 eid 原地重生） |

### 框架通用 BT 节点（`framework/ai/nodes/`）

- conditions：`IsTargetInVision`、`InAttackRange`
- actions：`Chase`、`Attack`、`Flee`（移动钳制工具抽到 `nodes/steer.ts` 共用）
- `ActionFactory` 返回类型放宽为 `State | boolean`（condition 返回布尔）

### game/ 配置

- `game/entities/boar.json`：Health 60, Attack{8,32}, Perception{160,80}, LootTable:[{raw_meat,1,1.0}], team 2, boar-hostile 行为
- `game/entities/rabbit.json`：Health 20, Perception{120,60}, rabbit-flee 行为（无攻击/无掉落）
- `game/behaviors/boar-hostile.json`：selector[ seq[IsTargetInVision,Chase,InAttackRange,Attack], Wander ]
- `game/behaviors/rabbit-flee.json`：selector[ seq[IsTargetInVision,Flee], Wander ]
- `game/items/raw_meat.json`：consume 回 hunger +30
- `game/entities/player.json`：加 Attack{10,40} + Cooldown（攻击入口：input.attack → Intent "attack"）
- `game/rules/respawn.json`：`{delayMs:2000, resetNeeds:true}`
- `game/spawns/populations.json`：boar max 3 / rabbit max 4

### 测试点

- perception 写黑板、attackTarget（射程/冷却/友伤/死亡守卫）、death 三分支（掉落/玩家标记/移除）、respawn 重置+传送+Needs、5 个 BT 节点经 createNpcTree+step 断言
- 集成：玩家击杀 boar → 掉肉落地；boar 感知 BT Attack 击杀玩家 → 重生回出生点
- 既有用例同步：combatSystem 自动攻击用例 → attackTarget 显式调用；needDecay 移除用例 → death/respawn 全链路

### demo 里程碑

敌对 boar 感知玩家后逼近攻击；玩家近战反击，击杀掉肉；玩家死亡自动重生。

---

## Slice 3 — 合成与装备（"有成长"）✅ 已完成

> **S3 实施修正（来自落地探查，写回此计划）**：
> - `Equipment` 落地为 **SoA**（固定三标量字段 weapon/tool/armorSlot，引用 Inventory 槽
>    idx，-1=空）——固定长度不属变长结构，SoA 可原生 query/netSync，无需 AoS 钩子/适配器
> - **craftingSystem 落地为命令驱动的原子模块（无 tick 体）**：合成是离散事件且需选配方，
>   意图通道（字符串脉冲）承载不了 recipe id，改走 PlayerCommand `{type:"craft", recipe}`
>   （inventoryOps 先例）；不注册系统、不进 game.json；GameRoom 仅扩展命令白名单
> - **equipmentSystem 注册为系统**（id="equipment"，after interaction），tick 体只做
>   装备槽引用卫生（指向空槽的 ref → -1，保证 netSync 的 Equipment 字段诚实）；
>   穿戴原子 `equipSlot` 走 PlayerCommand `{type:"equip", slot}`
> - **装备加成 on-read 修正**：combatSystem/gatheringSystem 每次读 `getEquipModifiers`
>   （攻击/防御数值累加、采集倍率乘算），组件值不变——无 base 字段、无逐 tick 变异、
>   测试残留面最小（legacy 数组跨 world 互踩是 S2 主要测试坑）；`unequip` 不做：
>   drop/transfer/consume 后引用被读取方自愈 + tick 体归 -1
> - item 穿戴效果进 `ItemKindSchema.equip`（slot/attackBonus/defenseBonus/gatherMult），
>   装备加成单源在 item kind 配置；combat 参数仍单源 `rules/combat.json`
> - armor 物品与 campfire_kit 的 Placeable 推迟到有真实需求（装备槽与加成数学已通用就绪）；
>   campfire 以静态实体 + population 规则放置（框架暂无地图静态实体机制）
> - `validateIntegrity` 补 recipe input/output 引用 item kind 存在性校验（防配置笔误）
>
> **S3 审查修复（第一轮，写回此计划）**：
> - 装备引用卫生与读取规则对齐：槽内换入不匹配物品（transfer 换物）也归 -1——
>   否则物品换回时加成会未经 equip 命令静默恢复，且 netSync 持续广播过期 ref
> - `submitCommand` 统一死亡/重生窗口守卫（与 applyInputs/interactionSystem 一致）：
>   死亡玩家不可 craft/equip/consume/drop/transfer（补的是 slice-2 遗留的同类缺口）
> - gatheringSystem：gatherMult 取整为 0 时（含 directConsume 路径）不动节点
> - framework/index 补导出 EquipEffect / CraftingRecipe / CraftingRule 类型
> - 记录不修（即需即补）：Equipment/CraftingStation 的 spawn 未声明字段残留
>   （潜伏，当前 game 配置三槽全声明规避；S5 联机前再议）、craftRecipe 部分产出
>   （全量拒绝是设计取舍）、attackTarget 缺 Transform/Team 边界（slice-2 既有）

### 新增框架组件

| 组件 | 形态 | 字段 |
|------|------|------|
| `Equipment` | SoA（落地修正） | `weaponSlot, toolSlot, armorSlot`（引用 inventory 槽 idx，-1=空） |
| `CraftingStation` | SoA | `stationType: ui32` |

### 新增/扩展框架系统

| 系统 | 职责 |
|------|------|
| `craftingSystem` | **原子模块**（落地修正：无 tick 体，PlayerCommand `craft` 驱动）：Recipe inputs 消耗 → output 产出；校 stationType；缺料/满包则拒（零副作用）；dry-run 防满包丢产出 |
| `equipmentSystem` | `equipSlot` 穿戴原子 + `getEquipModifiers` 加成读取 + tick 体槽位卫生（落地修正：加成 on-read 修正，组件值不变） |
| `gatheringSystem` | 读 Equipment 修正（工具 gatherMult 乘算单次产出） |
| `combatSystem` | 读 Equipment 攻防加成（攻击者 attackBonus / 目标 defenseBonus） |

### game/ 配置

- `game/rules/crafting.json`：recipes（wood_axe:2wood→axe / stone_axe:1wood+1stone→tool 采集×2 / spear:2wood+1stone→weapon+15 / berry_pie:3berry→高饱腹 / cooked_meat:1raw_meat→高饱腹，stationType=1）+ stationRange
- `game/entities/rock.json`：ResourceNode yields stone
- `game/entities/campfire.json`：静态 CraftingStation(stationType=1) 实体（落地修正：本切片以 population 规则放置；Placeable/摆放进 S4）
- `game/items/{axe,stone_axe,spear,berry_pie,cooked_meat,stone}.json`：equip 效果声明在 item kind（落地修正：ItemKindSchema 加 equip 字段）
- `game/entities/player.json`：加 Equipment{-1,-1,-1}
- `game/game.json`：systems 启用 equipment；netSync 加 Equipment/CraftingStation 字段

### 测试点

- 合成成功/缺料拒绝/满包拒绝（dry-run 零副作用）、半满堆叠合并、站点类型与距离校验
- equipSlot 三槽写入/拒绝、getEquipModifiers 槽类型匹配 + 空槽自愈、tick 体槽位卫生
- 装备数值生效（combat 攻防加成）、采集速率修正（gatherMult 翻倍）
- 命令路由（GameSimulation craft/equip）+ netSync 接线 + 真实 game 配置集成（validateIntegrity 校验 recipe 引用）

### demo 里程碑

采集石头+木头→合成石斧→装备后采集翻倍；合成矛→击杀 boar 更易。进度曲线成型。

---

## Slice 4 — 世界氛围（"世界活了"）✅ 已完成

> **S4 实施修正（来自落地探查，写回此计划）**：
> - `TimeOfDay` 按计划挂 `world.time.timeOfDay`（非 bitecs 组件），`{hour, phase}`；
>   相位用二进制编号（PHASE_DAY=0 / PHASE_NIGHT=1 常量），无需晨昏渐变（无消费方）
> - **火光回避落地在 perceptionSystem 感知侧**（通用约定：目标处于任一有效
>   LightSource 半径内 → 不可感知，"光=安全区"机制）。原计划的 wolf BT 条件方案
>   不可行：mistreevous selector 对 RUNNING 子节点有状态记忆（FAILED 分支在
>   RUNNING 期间不被重评估），入睡后无法醒、追击中无法改判；guard（每 tick 重求值）
>   是唯一可靠的切换机制，故同时落地 `IsTargetNotInVision` 条件 + btFactory/
>   validateIntegrity 支持 mistreevous `while/until` guard 条件收集
> - `Placeable` 落地为完整放置链路（demo 里程碑真实需求）：组件 + `ItemKindSchema.place`
>   （物品声明放置成哪个 archetype）+ PlayerCommand `place(x,y)` + placeableSystem 原子
>   模块（范围/实体重叠/地图阻挡校验零副作用 → 消耗 1 → spawn）
> - `SpawnSchema.condition` 落地为 spawnConditions 注册表（名 → 条件函数，isNight 内建），
>   spawningSystem 计时/上限检查后判定；validateIntegrity 校验 condition 已注册
> - 传输层：TickSnapshot.timeOfDay + RoomState hour/phase（world 级同步，不经 netSync 字段）
> - **未做（即需即补，记录不修）**：Weather（无消费方）、SeekLight（无行为树引用）、
>   zone 分区（simple 生成器硬编码单 zone，装饰性；wolf 用整图 zone + isNight 即可）
> - LightSource.fuelRemainingMs 无消耗系统（静态/放置火堆常亮大值；燃料消耗留待真实需求）
>
> **S4 审查修复（第一轮，写回此计划）**：
> - **Sleep 从 RUNNING 改为 SUCCEEDED**（树根每 tick 重置 → 全树重评估）：原 guard 方案
>   （Sleep + while IsTargetNotInVision）虽能"见敌即醒"，但 guard 中止不执行节点本体，
>   白天有目标等路径会残留追击速度；且 RUNNING 记忆使分支 1 光内入睡无 guard 时睡死。
>   SUCCEEDED 后"见敌即醒/天亮停手/光源失效改判"全部由树重置自然达成，无需额外 guard
> - **wolf-night 分支 2（追击）加 `while: {call:"IsNight"}` guard**：修复"追击中天亮仍攻击"
>   （guard 每 tick 重求值，天立即中断）；分支 3 改无条件 Sleep（清零速度兜底）
> - **`IsTargetNotInVision` 节点删除**（重设计后无消费方，即需即补）
> - **validateIntegrity 行为树校验修复**（S2 遗留顺手修）：collectActionNames 补
>   `child` 递归与 `call` 形态收集（原只认 `children` + `{name,type:"action"}`，所有
>   行为树引用未注册动作时校验静默放行）；guard 条件名收集随之真正生效
> - **guard 单对象形态**（问题 4）：mistreevous 校验层只接受单个 `{call}` 对象，
>   数组形态是误导性死代码，btFactory/loadGameDefinition 删除数组分支

### 新增框架组件

| 组件 | 形态 | 字段 |
|------|------|------|
| `TimeOfDay` | **world 级**（挂 `world.time`） | `hour, phase` |
| `LightSource` | SoA | `radius, fuelRemainingMs` |
| `Placeable` | SoA | `footprintW, footprintH, canCollide` |
| `Weather`（可选） | SoA | `type, intensity` |

### 新增/扩展框架系统

| 系统 | 职责 |
|------|------|
| `dayNightCycleSystem` | 推进 world.time，phase 切换触发生成规则（夜刷 wolf） |
| `weatherSystem`（可选） | 影响 Needs 衰减/采集速率（**未做**：无消费方，记录不修） |

### 扩展点

- `SpawnSchema` 加 `condition` 字段（引用 spawnConditions 注册表，isNight 内建）→ 夜刷狼用
- 通用 BT：condition `IsNight`/`IsInLight`，action `Sleep`（SUCCEEDED 语义）；
  btFactory/validateIntegrity 支持 mistreevous `while/until` guard 条件收集（单对象形态）
- **火光回避**：perceptionSystem 感知侧——目标在有效光源半径内不可感知（通用"光=安全区"机制）

### game/ 配置

- `game/rules/daynight.json`：`{cycleLengthSec:600, nightStartHour:19, nightEndHour:5}`（计划原 dayLengthSec 更名）
- `game/rules/place.json`：`{placeRange:64}`
- `game/entities/wolf.json`：夜间敌对，回避 LightSource
- `game/behaviors/wolf-night.json`：`selector[ seq[IsNight,IsInLight,Sleep], seq(while IsNight)[IsTargetInVision,Chase,InAttackRange,Attack], Sleep ]`
  （Sleep 为 SUCCEEDED 语义，树每 tick 重置——见敌即醒/天亮停手由重评估 + guard 达成）
- `game/entities/campfire.json`：LightSource{radius:80} + CraftingStation(cook) + Placeable
- `game/items/campfire_kit.json`：place→campfire + 配方（3 木 + 2 石）
- `game/maps/registry.json`：zone 划分**未做**（记录不修：simple 生成器硬编码单 zone）

### 测试点

- 时间快进覆盖夜间刷怪、火光回避（感知侧 + guard 唤醒）、放置校验、timeOfDay 同步

### demo 里程碑

昼夜交替可见，夜晚刷狼且狼回避火光；玩家可放火堆安全过夜。

---

## Slice 5 — 联机完整度（"能存档开服"）✅ 已完成

> **实施修正**（相对计划的偏差，均保持框架通用）：
> - **GameRoom.onCreate 为 async 已获源码验证**：@colyseus/core MatchMaker.createOne 在创建房间时
>   `await room.onCreate(...)`（build/MatchMaker.mjs），首个客户端 join 前读档恢复必然完成，无需降级方案
> - **persistenceSystem 不做成 ECS tick 系统**：AGENTS 硬边界禁止"系统里做异步 I/O"——
>   实现为 GameSimulation 层能力：tick 末尾按 `rules/server.json.saveIntervalMs` 累积 dtMs，
>   同步 serialize + fire-and-forget 写盘；读档经 `createGameSimulation(gameDef, {initialRecord})` 同步恢复
> - **antiCheatSystem 不做成 tick 系统**：输入校验必须在入口（submitInput/submitCommand，tick 前）
>   ——实现为 `inputValidation` 模块：`maxMoveSpeed` 超速拒（不推进 seq）+ `maxCommandsPerSec`
>   命令频率按 tick 滑动窗口限流（确定性，与真实时钟解耦）
> - **interestManagementSystem 分两段**：仿真层 `computeInterest`（viewRadius 裁剪，own 恒可见）
>   → TickResult.interest；传输层双路径——有规则写 per-client `PlayerState.visibleEntities`
>   （Colyseus 按连接分别增量同步），无规则保留 `RoomState.entities` 全量广播（兼容旧协议/旧客户端）
> - **Repository 接口替换**：旧 PlayerRecord/MapInstanceRecord（无消费方）→ WorldRecord（世界快照，
>   id/tick/nextNetworkId/timeOfDay/entities）；postgres/redis 因无驱动依赖留 stub 适配新接口，
>   `createFileRepository`（JSON 文件，原子写）为默认真实现（记录不修：外部 DB 等真实部署需求）
> - **玩家实体恢复语义**：读档恢复的玩家实体进复用队列，`addPlayer` 优先绑定（networkId 保留、
>   背包保留）；`removePlayer` 仍删除实体——断线后进度以最近一次存档为准
> - **serialize 瞬态组件跳过**：Velocity/Target/AIState/BlackboardRef/Cooldown/Duration/Intent/
>   LastSynced/Kind（恢复后由系统与输入自然重建，eid 跨存档不保真）

### 新增/落地框架系统

| 系统 | 职责 |
|------|------|
| `persistenceSystem` | 定时存快照（替换 stub）；玩家背包/状态/世界建筑 | 
| `interestManagementSystem` | 仅同步玩家视野内实体 |
| `antiCheatSystem` | 输入校验：速度上限、动作频率上限 |

> **后续对账注记（追加补充，不覆盖原文）**：上表三系统按计划形态书写，**落地形态
> 均为 GameSimulation 层能力而非 ECS tick 系统**（AGENTS 硬边界禁止"系统里做异步
> I/O"、输入校验须在入口）：定时存档=GameSimulation.maybeAutosave（tick 末尾）、
> 兴趣管理=computeInterest + GameRoom 双路径、输入校验=inputValidation 模块
> （submitInput/submitCommand 前置拦截）。详见本节实施修正。

### 扩展点

- `repository.ts` / `postgres.ts` / `redis.ts`：补真实现
- `game/rules/server.json`：存档间隔、视野半径、速率上限

### 测试点

- 存/读一致性、视野裁剪正确、超速输入被拒

### demo 里程碑

服务端重启不丢进度；多玩家同服各自只见视野内实体；超速输入被拒并日志。**核心Demo 到此贯通。**

---

## 完整目标（核心七切片之后，按需开启）

### Slice 6 — 建造（"玩家塑造世界"）✅ 已完成

> **S6 实施修正（来自落地探查，写回此计划）**：
> - **静态碰撞缺陷修复（建造前置）**：collisionSystem 原把全部实体注册为动态碰撞体——
>   玩家放置的墙会被顶走（campfire 潜伏缺陷）。落地为按 `hasComponent(Velocity)` 判静态
>   （生物/玩家声明 Velocity，建筑/资源不声明），静态体 `isStatic` 不被分离推开
> - **gridSnap 走配置开关**：`rules/place.json.gridSnap`（缺省 false 保持 S4 任意坐标行为，
>   既有测试零影响；真实配置开启）——对齐到地图网格（占位矩形四角落格线，中心取格组
>   中心），写入 `GridOccupancy` 格组 + 占用冲突校验（同格重放被拒），墙/地板无缝拼接
> - **拆除（deconstruct）原子 + 所有权**：`Placeable` 扩展 `ownerNetworkId`（0=世界物），
>   `deconstructEntity`（仅放置者可拆、范围校验、destroyEntity、**不返还材料**）；
>   PlayerCommand 加 `deconstruct` + `target`（networkId），GameRoom 白名单同步
> - **Portal 落地为 AoS 组件**（targetMap 是字符串引用，SoA 数值存不了）：AoS + 初始化钩子
>   + netSync 适配器（numbers x/y + strings targetMap）；**portalSystem 按数据存在性筛选**
>   （AoS 无 bitecs 组件标志，不能进 query——ItemMeta 同类陷阱）
> - **地图多源解析**：`loadGameDefinition` 由"只解析默认图"扩展为解析 registry 全部条目
>   （`resolvedMapSources`，key=地图 id，`resolvedMapSource` 保持默认图兼容）
> - **switchMap 原子**：`setWorldMap`（换图 + `world.systemRuntimes.clear()`——碰撞/刷怪
>   缓存惰性建，不重建则旧图阻挡格残留）+ `enterMap`（换图 + **清场 + 布置 + 传送玩家**；
>   清场保留"玩家内容"= Player tag / Placeable / ItemMeta（AoS 按数据存在性判定，
>   不能 hasComponent）——场景生态随图重置，玩家建筑/掉落物跨场景保留；读档恢复走
>   `setWorldMap` 不清场（存档实体是用户状态））
> - **持久化 mapId**：`WorldRecord.mapId`（serialize 写 world.map.id；GameSimulation 构造
>   读档后若地图不同调 `setWorldMap` 切回）；`TickSnapshot.mapId` → `RoomState.mapId`
>   （GameRoom 检测变化并强制订阅者重拉新图碰撞体）
> - **SpawnRule.mapId 过滤**：spawn 规则可限定生效地图（cave 差异化刷怪），validateIntegrity
>   校验地图存在
> - **切图语义=房间级**：所有玩家共享 world.map，任一玩家触发全员换图（多人洞穴=全队副本）；
>   per-player 分图状态不在本切片范围（记录不修）
> - **记录不修**：门为静态阻挡（可开关门需交互切换碰撞机制，无真实需求）；拆除不返还材料
>
> **S6 审查 P2 记录不修（追加补充，写回此计划）**——审查报告其余 P2 项（本轮未修，
> 随文档对账补充记录）：
> - P2-1：slice5 测试 `fileRepository` 并发写偶发失败（mkdir 微任务序竞态，非 S6 引入，
>   修 fileRepository 的 mkdir 幂等或测试等待）
> - P2-2：enterMap 保留物（玩家建筑/掉落）不检查新图边界——cave 32×32 下可能落图外
>   成虚空实体，切图后钳制玩家内容坐标到图内
> - P2-3：floor/furniture 与 wall 不可同格叠放（GridOccupancy 全局互斥）——"地板承托墙"
>   需层概念，当前无文档记录取舍
> - P2-4：portal/portal_back 由刷怪规则随机点生成——位置不稳定且可能刷进阻挡格，
>   需地图固定位置机制
> - P2-5：campfire 被动纳入 gridSnap（24px 占位对齐 2×2 格=32px）——全局开关连带结果，
>   行为一致可接受
> - P2-6：`Placeable.ownerNetworkId` 未进 netSync——客户端无法显示"自己的墙"，
>   deconstruct 权限仅服务端判定（客户端 UI 未牵引）
>
> **S6 审查修复（第一轮，写回此计划）**：
> - **portal 触发死锁（P0，审查发现）**：portal 原型带阻挡 Collider → 玩家每 tick 被
>   collisionSystem（SAT 分离）推到恰接触距离（= Size 半宽和）→ 触发判定用严格 `<` 时
>   恒 false——真实运行切图 100% 死锁（测试只直接调 portalSystem 未暴露）。修复双管齐下：
>   ① game 配置 portal/portal_back 去掉 Collider（传送门是触发区不阻挡移动）②
>   `aabbOverlap` 放宽为 `<=`（接触即触发，抗碰撞分离/浮点边界，任何带 Collider 的
>   触发区都可用）；补「movement+collision 分离到接触距离后 portalSystem 仍触发」集成用例
> - **换图缓存重建改选择性（P1）**：`setWorldMap` 原 `systemRuntimes.clear()` 连带清空
>   deathSystem 重生标记（玩家死亡窗口内他人切图 → 重复掷掉落 + 重置重生延迟）与
>   aiSystem 黑名单；改为只删地图相关缓存（collision/spawning），死亡/ai 缓存保留
> - **读档地图无效告警（P2）**：存档 mapId 不存在（配置删图）时 logger.warn 而非静默
> - 测试补 2 例（完整 tick 链触发、缓存选择性重建），**187 全绿**
> - **对账注记（追加补充，不覆盖原文）**：本节上方实施修正正文中
>   `world.systemRuntimes.clear()` 为**修复前实现**（当时按全量清空落地）；
>   选择性重建（只删 collision/spawning）以本节 P1 修复描述为准。

- 框架：`buildingSystem`（`placeEntity` 扩展——网格对齐/格组占用/所有权）、`deconstructSystem`
  （拆除原子）、`portalSystem`（场景切换 tick）、`switchMap`（setWorldMap/enterMap）、
  `GridOccupancy`/`Portal` 组件、Placeable 扩展 ownerNetworkId、静态碰撞修复、
  多地图加载（resolvedMapSources）、持久化 mapId、SpawnRule.mapId
- game：wall/floor/door/fence/furniture/portal/portal_back 实体 + 5 个 kit 物品与配方 +
  place.json gridSnap + cave 地图 + populations 分图规则
- demo 里程碑：合成墙/地板/门/围栏/家具 kit → 网格对齐建造庇护所（墙静态阻挡狼）→
  放置者拆除；进洞穴（资源/夜狼更多）→ 洞内 portal 回岛；服务端重启庇护所与所在图俱在

### Slice 7 — 社交进度（"世界有故事"）✅ 已完成

> **S7 实施修正（来自落地探查，写回此计划）**：
> - **范围取舍**：PLAN 原列 6 个系统（dialogue/quest/relationship/faction/achievement/
>   progression），按即需即补落地 **对话 + 任务 + 好感**；factionSystem（好感可替代）、
>   achievementSystem、progressionSystem 记录不修（后者 S3 已有装备成长维度）
> - **任务双形态**：collect（背包持有 itemKind ≥ goal，tick 检查）+ kill（玩家击杀
>   victimKind 计数）——击杀型需要事件机制：落地**帧内事件总线**
>   （`world.runtimeEvents` + emitEvent/consumeEvents，GameInstance.step 帧首清空；
>   combatSystem 致命一击 emit `killed` 事件，questSystem 一次取出全部分发——consume
>   是清空式消费，多任务共享同一批事件）
> - **对话入口=新交互键**（用户决策）：PlayerInput 加 `talk` 意图 → interactionSystem
>   路由最近 NPC → startDialogue；对话推进走 PlayerCommand `dialogue` {option}（命令
>   频率限流 20/s 兼容连续点击）
> - **对话/任务/好感均为 AoS 组件挂玩家**：`Dialogue`（瞬态会话：npcId/treeId/nodeId/
>   options——**入瞬态跳过名单**，恢复后自然重建）、`Quest`（持久 {questId,state,count}，
>   state 0未接/1进行/2可交/3完成）、`Relation`（持久 {npcKind,value}）；NPC 挂
>   `DialogueSource` {treeId}。netSync 经 AoS 适配器展平（options 按索引 option）
> - **对话效果驱动任务**：对话节点选项效果 = quest_accept/quest_submit/relation_delta；
>   效果失败不推进（停留可重试）；submit 好感对象=对话 NPC kind（对话时传入）
> - **任务配置段**：GameDefinitionSchema 加 `dialogues`/`quests` 段 + validateIntegrity
>   （treeId/questId/itemKind/rewards/victimKind 引用完整性）
> - **提交结算**：collect 型消耗任务物品（跨槽贪婪）+ 奖励 dry-run 防满包丢产出
>   （crafting 先例）→ 奖励入包 → 好感 → DONE；kill 型仅计数，无需消耗
> - **demo 任务线**（无词表词配置）：villager 对话树——接 collect_axe（交斧头→矛+
>   好感10）/ 接 hunt_task（猎恶兽×2 → 熟肉+好感15）——交/接同节点选项，
>   效果失败停留可重试
> - **记录不修**：faction/achievement/progression 系统（无真实需求牵引）、
>   对话选项好感解锁条件（无消费方）
>
> **S7 审查修复（第一轮，写回此计划）**：
> - **对话选项 `to` 引用校验 + 运行时一致性（P2，审查发现）**：配置笔误（to 指向
>   不存在节点）静默通过校验，且运行时行为不一致——效果已执行却结束对话并返回
>   false。修复：validateIntegrity 校验每个 option 的 to（缺省/`__end__`/树内节点，
>   含 start 节点存在性）+ advanceDialogue **先解析跳转目标再执行效果**（无效 to
>   停留、效果不执行、会话不关闭）；补 shim 校验测试
> - **AoS 适配器快照断言补强（P2-4）**：真实配置用例补 TickSnapshot 展平 key 断言
>   （Dialogue.treeId/nodeId/options 与 Quest.questId/state），199 全绿

- 框架：`dialogueSystem`（startDialogue/advanceDialogue + 效果执行）、`questSystem`
  （accept/submit + tick 进度）、`relation` 原子（addRelation/getRelation）、
  帧内事件总线（gameEvents）、AoS 组件 Dialogue/DialogueSource/Quest/Relation +
  适配器、PlayerInput.talk 意图、PlayerCommand dialogue、interactionSystem talk 路由、
  Dialogue 入瞬态名单、dialogues/quests 配置段 + 校验
- game：game/dialogues/villager.json（对话树）、game/quests/quests.json
  （collect_axe/hunt_task）、villager 挂 DialogueSource、game.json（quest 系统 +
  dialogues/quests 段 + netSync 4 条）
- demo 里程碑：按新交互键与 villager 对话 → 接任务 → 收集/猎杀 → 提交 → 奖励与好感；
  任务/好感入档（重启不丢），对话会话瞬态（重连重开）

### 后续候选（按需开启，追加补充）

> 核心七切片（S1-S7）全部完成后的候选方向聚合，按真实需求取舍（即需即补，
> 不在当前 demo 执行范围内）。来源：S6/S7 记录不修项 + ROADMAP 缺口 + 既有潜伏项。

| 候选 | 内容 | 出处 |
|------|------|------|
| 成就/等级/阵营 | achievementSystem / progressionSystem / factionSystem（事件总线已就绪，killed 事件可驱动统计） | S7 记录不修 |
| 对话好感解锁条件 | 对话选项按 Relation 值解锁 | S7 记录不修 |
| NPC 寻路 | Pathfinding（A* 网格绕障），当前 Wander/Chase 直行 | ROADMAP 缺口 |
| 可开关门 / 天气 / 燃料消耗 | door 交互切换碰撞 / weatherSystem / LightSource.fuelRemainingMs 消耗系统 | S4/S6 记录不修 |
| 保留物越界钳制 / 同格叠放层 | enterMap 后玩家内容坐标钳制到图内；"地板承托墙"层概念 | S6 审查 P2-2/P2-3 |
| portal 固定位置 / slice5 flaky 测试 | portal 刷怪随机点改地图固定位置；fileRepository mkdir 竞态 | S6 审查 P2-4/P2-1 |
| use 原子 / ownerNetworkId 同步 | "使用物品触发世界效果"命令；客户端显示自己放置物 | 选型表对账 / S6 审查 P2-6 |
| LagComp | 延迟补偿与客户端预测回滚 | ROADMAP 缺口 |

---

## 横切（每切片强制）

- **测试**：每新系统各 1 单测 + 1 集成快照，沿用 `framework/__tests__` 模式
- **文档**：每切片结束更新 `docs/ROADMAP.md` 已有→补的覆盖表
- **AGENTS.md**：不膨胀；遇新增陷阱（如 Inventory AoS 同类的 Needs runtime Map）才补 §AI 须知陷阱
- **游戏无关性 grep**：每切片收尾前 `rg -i "hunger|荒岛|wood|boar|berry|wolf" framework/` 必须空

## 执行节奏

每个切片建议：
1. 在 `fix/phase-0-framework-defects` 之后的约定下，开新分支（如 `slice-1-survival-loop`）做。
2. 切片内每特性走"三步决策"（纯配置 → 框架通用 → 先修扩展点）。
3. 收尾三同步，合回 main 前必须 `pnpm test` + `tsc --noEmit` + `pnpm tools validate` 全绿 + 游戏 grep 空。
4. 完成后在本文件对应章节标 ✅，更新 ROADMAP 覆盖表。