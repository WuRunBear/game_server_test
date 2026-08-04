# Survival-Island 切片实施计划

> 本文件是 survival-island 游戏从"可玩 demo"到"完整游戏"的切片路线。**demo 阶段
> 落地核心五切片**（Slice 1-5），完整目标在核心之后追加建造与社交切片。
>
> 每个切片是一个垂直玩法切片，收尾三同步：可玩 demo 前进 + 框架增长通用系统 +
> 测试/文档同步。一个切片未完成不开启下一个（缺陷阻塞除外）。

## 已定型的技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| **demo 边界** | Slice 1-5 核心循环 | 生存+战斗+合成+昼夜+联机存档，约 20-30 分钟单局贯通 |
| **完整目标** | 核心 + 建造(S6) + 社交(S7+) | demo 跑通后再评估是否继续 |
| **变长结构建模** | runtime AoS 数组 + spawn 初始化钩子 | Needs/ResourceNode/Inventory/ItemMeta/Intent 统一为 `[] as T[]` AoS，与现有 Kind/Inventory 先例一致；spawn 经组件注册表的 AoS 初始化钩子按 archetype 配置写入。**S1 已替代原 systemRuntimes Map 选型**（探查发现 Kind/Inventory 已是 AoS，统一一套机制更简；netSync 也据此统一适配） |
| **Inventory 模型** | slot 存 `{itemId, count}` + 容量走 archetype 配置 + 独立 `Equipment` 组件（weapon/tool/armor 三槽引用 inventory 槽） | 够支撑堆叠/容量/穿戴，不造格子拖拽引擎。客户端拖拽自便（**S1 落地**：slot `{kind,count}`，capacity 进 archetype，经 AoS 钩子初始化） |
| **服务端操作原子** | `equip/transfer/drop/consume/use` 作为 Inventory/Equipment 系统的对外接口 | 客户端 UI 调这些 RPC，服务端权威做数据变更与校验 |

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
| **SpawnSchema** | `{kind,zoneId,max,respawnMs}` | S4 | 加可选 `condition` 字段引用通用 condition 模块（夜刷狼用） |
| **RuleSchema** | 仅有 CombatRule（`.passthrough()`） | S1/S3/S4 | 加 `NeedsRuleSchema`（S1 已落地）/`CraftingRuleSchema`/`DayNightRuleSchema`；`ruleSchemas` 注册表已建（S1） |
| **BT 通用节点** | 已支持 action+condition | S2 | 在 `framework/ai/nodes/` 加通用 condition/action（IsTargetInVision/InAttackRange/Chase/Flee/Attack ✅ S2；IsNight/Sleep 属 S4）注册到 actionRegistry |
| **Persistence 接口** | stub | S5 | 补 `repository.ts` 实现 |

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

## Slice 4 — 世界氛围（"世界活了"）

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
| `weatherSystem`（可选） | 影响 Needs 衰减/采集速率 |

### 扩展点

- `SpawnSchema` 加 `condition` 字段（引用通用 condition）→ 夜刷狼用
- 通用 BT：condition `IsNight`，action `Sleep`、`SeekLight`

### game/ 配置

- `game/rules/daynight.json`：dayLengthSec=600
- `game/entities/wolf.json`：夜间敌对，回避 LightSource
- `game/behaviors/wolf-night.json`：`seq[cond[IsNight],cond[IsTargetInVision],act[Chase],act[Attack]] else Sleep`
- `game/entities/campfire.json`：LightSource + CraftingStation(cook)
- `game/maps/registry.json`：补 zone 划分（采集区/夜行区/出生点）

### 测试点

- 时间快进覆盖夜间刷怪、火光回避

### demo 里程碑

昼夜交替可见，夜晚刷狼且狼回避火光；玩家可放火堆安全过夜。

---

## Slice 5 — 联机完整度（"能存档开服"）

### 新增/落地框架系统

| 系统 | 职责 |
|------|------|
| `persistenceSystem` | 定时存快照（替换 stub）；玩家背包/状态/世界建筑 | 
| `interestManagementSystem` | 仅同步玩家视野内实体 |
| `antiCheatSystem` | 输入校验：速度上限、动作频率上限 |

### 扩展点

- `repository.ts` / `postgres.ts` / `redis.ts`：补真实现
- `game/rules/server.json`：存档间隔、视野半径、速率上限

### 测试点

- 存/读一致性、视野裁剪正确、超速输入被拒

### demo 里程碑

服务端重启不丢进度；多玩家同服各自只见视野内实体；超速输入被拒并日志。**核心Demo 到此贯通。**

---

## 完整目标（核心之后，按需开启）

### Slice 6 — 建造（"玩家塑造世界"）

- 框架：`buildingSystem`（玩家放置 Placeable + 网格占用 `GridOccupancy`）、`portalSystem`（场景切换）
- game：wall/floor/door/家具/fence 配置

### Slice 7+ — 社交进度（"世界有故事"）

- 框架：`relationshipGraph`（N:N 边权）、`dialogueSystem`（对话树）、`questSystem`、`factionSystem`、`achievementSystem`、`progressionSystem`
- game：NPC 对话/任务线/阵营/成就配置

> 这两切片在核心五切片跑通后再据实际取舍，不在当前 demo 执行范围内。

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