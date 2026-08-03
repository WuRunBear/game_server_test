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
| **BT 通用节点** | 已支持 action+condition | S2 | 在 `framework/ai/nodes/` 加通用 condition/action（IsTargetInView/IsNight/Chase/Flee/Sleep）注册到 actionRegistry |
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

## Slice 2 — 战斗闭环（"能打、有收益"）

**依赖**：Phase 0 combat 射程、bt condition 已修。

### 新增框架组件

| 组件 | 形态 | 字段 |
|------|------|------|
| `LootTable` | **runtime `Map<eid, LootEntry[]>`** | `LootEntry={kindId, qty, chance}` |
| `Perception` | SoA | `visionRadius, hostilityRange` |

### 新增/扩展框架系统

| 系统 | 职责 |
|------|------|
| `perceptionSystem` | 扫视野内实体写黑板 nearbyTargets（攻击/逃跑用） |
| `lootSystem` | 实体死亡 → 按 LootTable spawn item 实体 |
| `deathSystem` | Health≤0 → loot → removeEntity；玩家分支留死亡标记 |
| `respawnSystem` | 玩家死后按 SpawnPoint 重生 |

### 框架通用 BT 节点（`framework/ai/nodes/`）

- conditions：`IsTargetInVision`、`InAttackRange`
- actions：`Chase`、`Attack`、`Flee`

### game/ 配置

- `game/entities/boar.json`：Health, Attack, Perception, LootTable:[{raw_meat,1,1.0}], team 2
- `game/entities/rabbit.json`：rabbit-flee 行为
- `game/behaviors/boar-hostile.json`：`seq[cond[IsTargetInVision],act[Chase],cond[InAttackRange],act[Attack]] else act[Wander]`
- `game/behaviors/rabbit-flee.json`
- `game/items/raw_meat.json`

### 测试点

- perception 写黑板、loot 概率掉落、玩家死亡触发 respawn
- 集成：spawn boar + 玩家，跑 tick 至战斗结束，断言掉肉 + 重生

### demo 里程碑

敌对 boar 感知玩家后逼近攻击；玩家近战反击，击杀掉肉；玩家死亡自动重生。

---

## Slice 3 — 合成与装备（"有成长"）

### 新增框架组件

| 组件 | 字段 |
|------|------|
| `Equipment` | `weaponSlot, toolSlot, armorSlot`（引用 inventory 槽 idx） |
| `CraftingStation` | `stationType: u32` |

### 新增/扩展框架系统

| 系统 | 职责 |
|------|------|
| `craftingSystem` | Recipe：inputs 消耗 → output 产出；校 stationType；缺料/满包则拒 |
| `equipmentSystem` | 穿戴 → 影响 Attack/Defense/采集速率（S1 预留的 equip 原子在此生效） |
| `gatheringSystem` | 读 Equipment 修正（axe→wood×2） |
| `combatSystem` | 读 Equipment 攻防加成 |

### game/ 配置

- `game/rules/crafting.json`：recipes（wood_axe:2wood→axe / stone_axe:1wood+1stone / spear:2wood+1stone→近战+15 / berry_pie:3berry→高饱腹 / cooked_meat:需 stationType=cook）
- `game/entities/rock.json`：ResourceNode yields stone
- `game/items/{axe,stone_axe,spear,berry_pie,cooked_meat}.json`
- `game/items/campfire_kit.json`：可 Placeable CraftingStation（火堆烹饪实际进 S4，本切片先放静态 campfire 实体）

### 测试点

- 合成成功/缺料拒绝/满包拒绝、装备数值生效、采集速率修正

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