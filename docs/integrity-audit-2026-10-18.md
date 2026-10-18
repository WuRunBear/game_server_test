# 完整性审计与修复计划（2026-10-18）

> 来源：两路只读审查——oracle 深度代码评审（正确性/功能缺口）+ explorer 全仓机械扫描
> （占位/死代码/配置/文档漂移）。审查基线：`940adbf`（85 文件 / 1055 用例全绿）。
> 本文件是**修复清单**：每条含位置、问题、后果、修复方向、验收方式。
> 修复按第 6 节批次推进；每批完成需更新本文件状态（☐ → ☑）并跑第 7 节验收。

## 0. 总原则

- framework 里既有"留接口未接线"的桩，也有"文档称完成但实现不全"的缺口；game/ 配置里
  有大量用魔法值代替设计的占位；src/ 基本无占位（`src/register.ts` 为空是设计目标）。
- 修复优先级：先堵可利用的权威/安全缺陷，再补"已标完成但玩家不可感知"的功能，最后清理
  死代码与文档。
- 涉及协议的修改（`EntityState.level`、netSync 字段）必须同步
  `src/network/colyseus/client-schema/schema.ts` 手动副本，并在本文件标注"协议变更"。

---

## 1. P0 —— 服务端权威/安全（可利用）

### ☑ F-01 `offer` 命令可越权搬空/销毁任意容器物品
- 位置：`framework/simulation/GameSimulation.ts:629-641`、`framework/economy/offer.ts:91-95`、
  `framework/economy/settle.ts:77-124`、`framework/simulation/types.ts:91-92`、
  `framework/net/colyseus/rooms/GameRoom.ts:76`
- 问题：客户端提交 `TradeParty[]`，`party` 是服务端 eid；`openOffer` 只把发起者列入已确认，
  非 Player 一方按"即时成立"自动确认 → 任意带 Inventory 的实体（尸体/箱子）被自动确认并结算。
- 后果：攻击者可枚举 eid，构造条款搬空/销毁任意容器物品；服务端权威被绕过。
- 修复方向：`offer` 只接受"以本人为一方的双人条款"，其余 party 必须由该方在 `acceptOffer`
  显式确认；禁止把非 Player 方当作自动确认方；商店走 `dialogueSystem` 专用路径。
- 验收：新增测试——构造第三方 party 的 offer 被拒；只有双方显式确认才结算；现有经济测试零回归。

### ☑ F-02 容器/对话交互缺距离与可达性复核
- 位置：`framework/systems/gameplay/inventoryOps.ts:220-259`（`lootContainerSlot`）、
  `framework/simulation/GameSimulation.ts:593-602`、`framework/systems/gameplay/dialogueSystem.ts:216-252`
- 问题：`transfer + target` 只校验同图，不校验距离/层；`advanceDialogue` 只在
  `startDialogue` 校验过距离，之后可走远继续买卖/交任务。
- 后果：隔墙/隔层搬空容器，远距离交易与交任务（与 `deconstruct` 的 `isGameplayReachable`
  不一致）。
- 修复方向：容器拾取走 `isGameplayReachable`（玩家↔容器同层+射程）；`advanceDialogue` 每次
  选项推进重新解析 NPC 实体并校验距离；对话可配置过期。
- 验收：新增测试——隔层/超距 transfer 被拒、走远后 advanceDialogue 被拒；现有测试零回归。

### ☑ F-03 断线保留实体丢 `Offline` 标记 + orphan FIFO 身份错绑
- 位置：`framework/persistence/worldSerializer.ts:57-58,139-141`、
  `framework/components/offline.ts:2`、`framework/simulation/GameSimulation.ts:417-442`
- 问题：`Offline` 在 `RUNTIME_ONLY_COMPONENTS`，重启后恢复的玩家实体无离线标记；而序列化器
  全量导出玩家实体；`addPlayer` 仅按 `[NetworkId,Player,Offline]` 匹配保留实体，失败后
  `orphanPlayerEids.shift()` 按存档顺序把任意玩家实体交给新客户端。
- 后果：重启后离线玩家进入全部玩法系统（饥饿/被感知/被袭击/可见）；A 的角色可能被 B 继承，
  断线保留在重启后完全失效。
- 修复方向：`Offline` 改为入档（或持久化 `offlineUntilTick`），恢复时重新打标记并清扫过期；
  `addPlayer` 只在客户端出示匹配 `networkId` 时复用，取消 FIFO 兜底（或限定同 networkId）。
- 验收：新增测试——断线→存档→重启→保留实体仍带离线标记且对系统不可见；重连按 networkId
  命中；不匹配时不挪用他人实体。

---

## 2. P1 —— 功能缺口（文档称完成但实际不全）

### ☑ F-04 双时钟错位：离线补差只推 tick，不推 `timeOfDay`
- 位置：`framework/map/runtime/clock.ts:28-32`、`framework/systems/gameplay/dayNightCycleSystem.ts:36`、
  `framework/systems/gameplay/spawnConditions.ts:125-126`、`framework/simulation/GameSimulation.ts:330-332`
- 问题：`tick` 离线跳 1.7M，`timeOfDay` 只按 dtMs 累加；`isNight/isDay` 与客户端
  `RoomState.hour/phase` 读 timeOfDay，季节/天气/灾害读 tick 派生环境。
- 后果：重启后夜晚刷怪按旧相位、客户端钟表停在存档时刻；在线 dt clamp 也造成缓慢漂移。
- 修复方向：删除累积式 `timeOfDay`，`hour/phase = f(tick)`（与 worldClock 同一套纯函数）。
- 验收：离线跨 N tick 后 timeOfDay 与逐 tick 推进一致；isNight 与 environmentAt 相位一致。

### ☑ F-05 楼层无"支撑"判定：走出楼板边缘继续悬空
- 位置：`framework/systems/core/entityLevelSystem.ts:148-177`、
  `framework/map/geometry/query.ts:82-84`
- 问题：层号只在 slope/connector/跳崖时变化；没有"脚下无地形支撑且本层无楼板则下落"。
  `walkable=1` 的格任意层都返回可走。
- 后果：二层可走出楼板悬空行走；楼层玩法只在深水/悬崖上有效。
- 修复方向：`resolveEntityLevel` 增加支撑判定——当前层无地形支撑且本层无楼板时，层号落到
  `max(地形层, 最高有楼板层)`；不做完整重力系统。
- 验收：新增测试——从 L1 楼板边缘走出后落到地形层；无楼板区域不可站立；现有楼层测试零回归。

### ☑ F-06 玩家可见状态未进协议
- 位置：`framework/net/colyseus/state/EntityState.ts:34-49`、
  `framework/simulation/aosSyncAdapters.ts:78-92`、`game/game.json`（netSync）、
  `framework/systems/gameplay/craftingSystem.ts:476-500`
- 问题：`EntityState` 无 `level`；netSync 无 `Structure`；Inventory 适配器只展平 kind/count
  （无 durability/spoilAt）；`craftingProgressOf` 无同步通道；配方解锁态无同步。
- 后果：多层/耐久/延时制作/建筑类型在客户端不可见，已标 ✅ 的功能玩家无法感知。
- 修复方向：`EntityState` 加 `level`（协议变更，同步 client-schema）；netSync 增
  `Structure.role/connectDir`、`Inventory.{i}.durability`、制作任务投影；配方解锁态可选。
- 验收：快照含新字段；client-schema 副本结构一致测试；旧客户端问题在文档标注（协议变更）。

### ☑ F-07 死亡容器 TTL 依赖瞬态 timer → 重启后尸体永久存在
- 位置：`framework/systems/gameplay/deathSystem.ts:101-104`、
  `framework/persistence/worldSerializer.ts:72-73`
- 问题：容器到期靠一次性 `ExpiresAt`，manifest 为瞬态；重启后无重建路径。
- 后果：每次"死亡+重启"泄漏一个实体与一份战利品；容器数量单调增长。
- 修复方向：容器到期改为持久绝对 tick 字段（或 boot 时按创建 tick + ttl 重建 timer）；
  顺带修复 `deathSystem` 重启后 0 血玩家重复生成空尸体。
- 验收：存档→重启→容器在剩余时间内仍在、到期被清；不重复生成空容器。

### ☑ F-08 无停机存档：每次重启丢 ≤60s 在线进度
- 位置：`framework/net/colyseus/rooms/GameRoom.ts`（无 onDispose）、
  `framework/simulation/GameSimulation.ts:684-718`、`src/main.ts`（无 SIGTERM 处理）
- 问题：`saveNow` 只由定时器与断线保留到期触发；进程退出无 flush，且 save 未 await。
- 修复方向：`GameRoom.onDispose` + SIGINT/SIGTERM 调用 `sim.flushSave()` 并 await；
  `removePlayer` 顺手落盘。
- 验收：模拟 dispose 后存档包含最新 tick/实体；崩溃路径不覆盖旧档（与 F-09 配合）。

### ☑ F-09 损坏存档被静默当成"无档"
- 位置：`framework/persistence/fileRepository.ts:53-60`
- 问题：读取/解析错误一律 `return null`，无日志；随后开机生成新世界并可能覆盖旧档。
- 修复方向：区分"文件不存在"（合法无档）与"解析失败"（fail-fast：抛错/拒绝启动/备份后告警）；
  写盘使用临时文件+原子 rename。
- 验收：损坏档启动报错并保留原文件；正常无档仍可新建。

### ☑ F-10 生态 node 模式无死亡回写："杀多了不会变少"
- 位置：`framework/simulation/population/populationSystem.ts:91-117`、
  `framework/map/evolution/engine.ts:17-19,259-262`
- 问题：`Population.count` 是目标数，没有死亡反馈；杀光后下一槽补满。
- 修复方向：死亡时按 species+区域找到节点 `count -= 1`（下限 0）；增长按间隔回补；
  同时评估 `Nest` 与 `Population` 双通路并存的重复生产风险。
- 验收：杀 N 只后节点 count 下降且下一槽不立即补满；长期死亡率与增长率可收敛。

### ☑ F-11 离线补差的成本与告警缺陷
- 位置：`framework/map/evolution/engine.ts:134-141,239-266`、
  `framework/map/evolution/placement.ts:20,87-118`
- 问题：低于上限但补不上时每槽 32 次尝试 → 24h 离线数百万次判定；`spawnExact` 非法落点
  每槽 warn 一次（野火后 portal 落点变不可走 → 86,400 条日志）。
- 修复方向：离线补差加"每规则连续失败槽上限"（如 64）并跳到边界；`spawnExact` 告警按
  (map,rule,reason) 去重。
- 验收：构造不可落位规则，离线补差耗时有上界、日志条数有上界。

### ☑ F-12 栅栏/门不被视为 Structure：袭击免疫 + 寻路磨墙
- 位置：`game/entities/fence.json`、`game/entities/door.json`、
  `framework/ai/pathfinding/astar.ts:270-275`、`framework/systems/gameplay/raidSystem.ts:163-166`
- 问题：fence/door 有 Collider 但无 `Structure(role=wall)`、无 `Health`；A* 认为可通行，
  袭击不选为目标。
- 后果：栅栏圈 100% 免疫袭击；怪物沿路径磨墙。
- 修复方向：可建造屏障统一加 `Health + Structure(role=wall)`；A* 阻挡索引纳入
  "有 Collider 的建造实体"。
- 验收：袭击可破坏栅栏/门；A* 绕行不再穿栅栏；玩家可正常通行门（若保留门交互）。

### ☑ F-13 多层建造内容不可达
- 位置：`game/items/stairs_up_kit.json`、`stairs_down_kit.json`（无配方/掉落）、
  `game/entities/door.json`（无交互）、`game/entities/wall_upper.json`（零引用）
- 问题：框架层楼层建造完成，但楼梯 kit 无获取途径；门无开关；上层墙原型未使用。
- 修复方向：补楼梯配方/掉落；实现门开关（或明确门为静态墙并移除 door kit）；清理/使用
  `wall_upper`。
- 验收：玩家可从零制作并搭出可上下的二层；门可开合（若保留）。

### ☑ F-14 projectile 未启用（文档虚报"投掷矛 demo 完成"）
- 位置：`framework/systems/registerBuiltinSystems.ts:216-221`、`game/game.json`、
  `docs/gameplay-v2-design.md:90,155`
- 问题：系统已注册但未启用；无 `spawn-projectile` 引用、无投掷武器。
- 修复方向：启用 projectile 系统 + 投掷武器配置 + 瞄准输入；或从文档删除"已完成"声明。
- 验收：投掷武器可按输入方向发射并命中结算；文档与实现一致。

### ☑ F-15 季节派生视图与 `growthScale` 未实现
- 位置：`framework/simulation/worldClock/index.ts:48-69`、`game/rules/environment.json:8,20,32,45`
- 问题：只有 `GroundDerivationFn` 类型；`growthScale` 零消费方；积雪/湿地面未实现。
- 修复方向：实现 `effectiveGround` 纯函数（底板语义+相位+进度+level+区域+hash→有效语义）
  并接入游戏逻辑/快照；`growthScale` 接到作物/资源再生速率（FSM 定时缩放）。
- 验收：冬季草地查询为雪地、雪线随进度移动；资源再生速率随相位变化。

### ☐ F-16 `setLevel` 写回缺失
- 位置：`framework/map/runtime/terrainWriteback.ts`、`docs/map-system-v2-design.md:48`
- 问题：设计声明 `setGround/setWalkable/setLevel` 三入口，实现只有前两者，偏差清单未记。
- 修复方向：补 `setLevel`（含指纹/碰撞失效/脏格），或把设计改为"level 写回后置"并记录。
- 验收：二选一，文档与实现一致。

### ☐ F-17 坠落伤害未实现
- 位置：`framework/systems/core/entityLevelSystem.ts:176`、
  `docs/map-system-v2-design.md:24`
- 问题：cliff 跳下只放行，无 cliff 语义校验、无按层数伤害。
- 修复方向：跳下时校验 cliff 语义并按层差配伤害（`damage` 效果或直接 Health 结算）。
- 验收：从 2 层以上跳下按配置扣血；slope 下行不扣血。

### ☑ F-18 template 锚点跨区域计数缺陷（ROADMAP 164）
- 位置：`framework/map/evolution/engine.ts:153-176`、`docs/ROADMAP.md:164`
- 问题：`spawnTemplate` 只校验偏移格可放置，不校验锚点仍属于 `rule.region`；
  `countByKind` 按区域计数 → 锚点落出区域会跨调用无界补种。
- 修复方向：`spawnTemplate` 增加"锚点与全部占用格仍属 rule.region"校验（或按锚点区域计数）。
- 验收：构造边界区域模板规则，多次 evolve 后数量不超过 max；现有测试零回归。

### ☑ F-19 采集溢出物掉到地图原点
- 位置：`framework/systems/gameplay/gatheringSystem.ts:148-157`
- 问题：部分入包后剩余用 `spawnDroppedItem(...,0,0,...)`，掉到 (0,0) 而非采集者/节点位置。
- 修复方向：使用采集者或节点坐标；不可达格时选最近可走格。
- 验收：满包采集时掉落物出现在节点附近；不再出现 (0,0) 物品。

### ☑ F-20 `new-game` 脚手架产物无法通过 validate
- 位置：`tools/new-game.ts:83-97`、`framework/config/schema/MapRegistrySchema.ts:51-54`、
  `README.md:23`
- 问题：生成 `kind:"generated"/generatorId:"simple"`，schema 只接受 `pipeline|tiled`。
- 修复方向：脚手架改为生成合法 pipeline（或 schema 支持该 kind）；README 标注状态。
- 验收：`pnpm tools new-game` 产物 `pnpm tools validate` 通过；README 与行为一致。

### ☑ F-21 规则 schema 缺口：place / progression
- 位置：`framework/config/schema/ruleSchemas.ts:52-64`、`game/rules/place.json`、
  `game/rules/progression.json`
- 问题：两条规则 raw 透传无校验（progression 仅工厂期 fail-fast；place 完全无）。
- 修复方向：补 `PlaceRuleSchema`、`ProgressionRuleSchema` 并注册。
- 验收：非法 place/progression 配置在 validate 阶段报错。

---

## 3. P2 —— 明显的简化/正确性边界（可接受，需记录或择机修）

| ID | 位置 | 问题 | 处理 |
|---|---|---|---|
| F-22 | `inventoryOps.ts:79,135` + `spoilSystem.ts:52-93` | 腐烂整堆取最早 spoilAt（混批全坏） | 记录；可选按批次拆堆 |
| F-23 | `craftingSystem.ts:291-293,433-435` | 合成产物未传 nowTick，spoilAt 晚 1 tick 补写 | 低成本修 |
| F-24 | `achievementSystem.ts:149-169` | 无在线玩家时成就奖励永久丢弃 | 改为"待领取"进度键，上线兑换 |
| F-25 | `builtStructures.ts:103-111,142-149` | 同格第二个连接器被静默丢弃 | 加载期校验 + 告警 |
| F-26 | `indoors.ts:73-80`、`builtStructures.ts:230-249` | 房间检测 256 格上限、图边界当墙 | 记录；可配置上限 |
| F-27 | `factions.ts:22-28` | 势力声望复用 Relation（`faction:` 前缀），语义混淆 | 记录；消费方按前缀过滤 |
| F-28 | `aosSyncAdapters.ts:78-92` | 其他玩家的背包槽位对视野内客户端可见 | 合作向可接受；PvP 前裁剪为仅自己 |
| F-29 | `navigate.ts:151-152` | 目标格抖动绕过节流；A* 无每帧预算 | 加目标稳定阈值 + 每帧预算上限 |
| F-30 | `GameSimulation.ts:704-718` | 自动存档在 tick 线程同步序列化全图 | 记录；后续改增量/异步 |
| F-31 | `populationSystem.ts:239-240` | 离线不实例化 spawnInstances | 当前全关，记录 |
| F-32 | `deathSystem.ts:141-152` | 重启后 0 血玩家重复掉落/空尸体 | 已随 F-07 修复：恢复时补重生标记，deathSystem 跳过 |
| F-33 | `game/rules/dialogue.json:2` vs `game.json:44` | `talkRange:48` 被 interaction.range 24 先筛 | 已在批次 A 修复：talk 分支读 dialogue.talkRange，interaction.range 只约束 interact/attack |
| F-34 | `game/ecosystems.json:131-136` | rocky 夜狼 `every:155520000 + isNight` 永不触发 | 已修：every→900，保留 max 1 + isNight |
| F-35 | `game/entities/campfire.json:7`、`water_pool.json:7-8` | 魔法值 1e9 / 9999 表达"近似无限" | 已修：ResourceNode.infinite + LightSource.fuelInfinite |
| F-36 | `tools/validate.ts:26` | 打印的 12 条不是运行时规则总数（生态展开在 boot） | 已修：文案标注"配置规则，运行时另展开" |

---

## 4. P3 —— 占位/死代码/卫生

### ☐ F-37 桩后端
- `framework/postgres.ts`、`framework/redis.ts`：空实现且未导出。处理：删除或标注"未实现、
  不可用"并在文档中明确；不假装可用。

### ☐ F-38 零消费者组件/效果/导出
- 组件：`AIState`、`Target`、`BlackboardRef`、`Duration`、`LastSynced`、`Perception.hostilityRange`
- 效果：`heal`、`spawn-projectile`、`impulse`、`ledger`、`spawn-entity`
- 导出/函数：`subscribeEvent`、`dispatchEvents`、`drainDirtyTiles`、`setWalkable`（仅测试）、
  `listIndoorEntities`、`clampMs`、`addTrigger`、`clearTimers`、`spawnInitialEntities`、
  `materializePopulation`、`populationSnapshot`
- 处理：逐项决定"接线使用 / 删除 / 注释标死"；`hostilityRange` 要么实现受击反击，要么删配置。

### ☐ F-39 死事件：`on-item-break` / `on-achievement` 无触发器求值器
- `framework/simulation/triggers/triggerRegistry.ts:91-100`、`durability.ts:78`、
  `achievementSystem.ts:163`
- 处理：注册求值器（配置可消费）或在文档明确"仅服务端事件"。

### ☐ F-40 未使用内容
- `wall_upper`（零引用）、`Idle`（无树使用）、`ca-cave`/`height-mask`（无图使用）、
  `Ledger`（无 archetype/效果启用）、`QUEST_AVAILABLE`（未使用）
- 处理：接入演示或删除/标注。

### ☐ F-41 死配置/魔法值清单化
- `initialAgeTicks/every=155520000/51840000`、campfire 1e9、water_pool 9999、
  `building-demo initialAgeTicks:1`——统一注释"语义=近似无限/只刷一次"，或改为显式字段。

### ☑ F-42 客户端 schema 维护方式过时
- `src/network/colyseus/client-schema/schema.ts:1-9` 称"仓库无 codegen"，实际
  `node_modules/.bin/schema-codegen` 可用。处理：接 codegen 或改注释 + CI 校验生成物一致。

### ☑ F-43 输入校验缺口
- `GameSimulation.ts:776-789`、`GameRoom.isPlayerInput`：seq 未校验整数/有限值；无
  `maxMoveSpeed` 时 NaN 可直接进 ECS。处理：严格数值校验（finite/范围）。
- 实施记录：seq 必须有限非负整数；moveX/moveY 缺失/null 按 0，出现时必须 finite；
  每轴安全上限 `MAX_INPUT_AXIS = 10_000`（协议单位是像素/秒，不是 [-1,1]；速度上限
  仍由 `maxMoveSpeed` 拒绝式校验负责）；NaN/Infinity 整条拒绝；interact/attack/talk
  归一布尔。GameRoom 浅校验同规则。

### ☐ F-44 商店无限货架/钱箱
- `dialogueSystem.ts:150-190`：单方 settle，无商人库存/资金；卖出物品直接消失。
- 处理：至少给商人配置库存/资金（可复用 Ledger），或文档明确"抽象商店"。

### ☐ F-45 文档纠偏（逐条）
- `docs/map-system-v2-design.md`：偏差清单补 `setLevel`、坠落伤害、季节派生视图、
  `ca-cave` 未用于任何图。
- `docs/gameplay-v2-design.md`：删除"投掷矛 demo 完成"虚报；"未落地：无"改为实际缺口表；
  `on-item-break` 触发器未注册的事实。
- `docs/gameplay-features-design.md:70`：computeStat 已接入（注释过期）。
- `docs/ROADMAP.md:104,146`：`RoomState.entities` 已删除；存档畸形防御与实际不符。
- `docs/HANDOFF.md:100`：待办口径过期。
- `docs/CLIENT-INTEGRATION.md:201`：gold_rock `regenMs:0` 不会消失的描述错误。
- `framework/map/geometry/types.ts:7`、`clock.ts:10`、`PlayerRuleSchema.ts:7`、
  `registerBuiltin.ts:6`、`GameSimulation.ts:381` 等"尚未实现/后续 todo"注释已过期。

### ☐ F-46 浅测试补强
- `map-boot-smoke`、`map-generate-aux`、`map-validate-integrity`、`map-validate-level`、
  `runtime-boundaries`（schema 结构）：补行为断言（尤其针对 F-01/F-02/F-05/F-07/F-19）。

---

## 5. 修复批次（建议顺序）

1. **批次 A —— 权威与数据安全**：F-01、F-02、F-03、F-09、F-08（+F-43 输入校验）
2. **批次 B —— 核心玩法完整性**：F-05（楼层支撑）、F-04（单一时钟）、F-07/F-32（容器 TTL）、
   F-19（溢出掉落）、F-18（template 锚点）
3. **批次 C —— 协议与可感知性**：F-06（level/耐久/制作进度/Structure 同步）+ client-schema
   同步；F-42（codegen/一致性校验）
4. **批次 D —— 内容可达性**：F-13（楼梯/门）、F-12（栅栏/门结构防御）、F-14（projectile 或删声明）、
   F-20（new-game）、F-21（规则 schema）、F-33/F-34/F-35（配置纠偏）
5. **批次 E —— 生态与季节**：F-10（死亡回写）、F-15（派生视图/growthScale）、F-11（离线成本）
6. **批次 F —— 卫生与文档**：F-16/F-17（setLevel/坠落，或改文档）、F-22~F-36 择机、
   F-37~F-44 清理、F-45 文档纠偏、F-46 浅测试补强

## 6. 每批验收标准

- `pnpm test` 全量通过（基线 85 文件 / 1055 用例；新增用例不得删旧断言）。
- `pnpm build` 零类型错误；`pnpm tools validate` 通过。
- 涉及协议的批次：client-schema 副本与服务端字段逐项一致（含结构测试）。
- 每批完成后更新本文件对应 ☐ → ☑，并在提交信息引用 F-ID。
- 对"已声明完成"的项（F-06/F-14/F-15 等），修复后同步更新两份设计文档的实施状态。

---

## 7. 实施记录

### 批次 A（提交 `183c3fb`，86 文件 / 1073 用例）
- F-01 offer 只允许双方均为在线 Player，发起者在条款中，另一方显式 accept；economy 原语保留。
- F-02 lootContainerSlot 同图/同层/距离（place.json `containerRange` 64）；Dialogue 增运行时 `npcEid`，advance 每次重校验；对话半径统一 `dialogue.talkRange`。
- F-03 `Offline` 入档（仅实际挂载实体写字段）；取消 orphan FIFO，按 networkId 严格复用；旧档玩家补标离线保留。存档格式变更（旧档不兼容）。
- F-08 `flushSave` + `GameRoom.onDispose` + Colyseus gracefullyShutdown（SIGINT/SIGTERM）。
- F-09 损坏档抛错保留原文件；写入临时文件+原子 rename。
- F-43 seq/坐标数值校验；协议单位 px/s，故每轴安全上限 10000 而非 [-1,1]，速度上限仍由 maxMoveSpeed 负责。

### 批次 B（提交见 git log，88 文件 / 1095 用例）
- F-05 `supportLevelAt`：当前层无楼板/地形支撑时回落 `max(地形层, 可站楼板层)`，只向下不向上；连接器两端视为站立面；楼板索引与 walkableAtLevel 同源。
- F-18 `spawnTemplate` 校验模板全部条目中心格仍属 `rule.region`，越界候选整组跳过。
- F-19 采集溢出以节点为锚 + 确定性散布（4~12px），walkable 回退链，落在节点/采集者附近。
- F-04 新增 `worldClock/dayNight.ts` 纯函数时钟（ticksPerDay = cycleLengthSec × tickRate；tick 0 锚定 8 时），dayNightCycleSystem 只做重算写入；advanceTickTo 后同步；离线补差改为先推 tick 再 evolve（按终点相位求值）；快照 hour/phase 同源。
- F-07 新增持久 SoA `Lifetime.expiresTick`（入档），timer 系统清扫到期容器；TTL 配置语义不变。
- F-32 恢复出的 0 血玩家直接补重生标记，deathSystem 跳过 → 不重复掉落/不生成空容器。

### 批次 C（90 文件 / 1105 用例）
- F-06 协议补全：`EntityState` 末尾新增 `level:int8`（字段索引 3；协议变更，需升级客户端）；
  动态 key 增补 `Structure.role/connectLow/connectHigh/connectDir`、
  `Inventory.<i>.durability`（无耐久不写键）、`ItemMeta.durability`、
  `Crafting.<i>.{recipeId,remainingTicks,progress,suspended}`（复用 values/stringValues，
  不新增 PlayerState 字段；Crafting 为派生伪组件，netSyncDerived 单一名单同时服务校验与快照）。
- F-42 schema 维护：确认 `schema-codegen RoomState.ts --ts --bundle` 可用；client-schema 副本
  改为 codegen 产物（保留手写头），新增 `pnpm schema:gen` / `pnpm schema:check`（临时生成→
  逐字段比较，含 CI 友好退出码）与一致性测试；移除"仓库无 codegen"的错误注释。

### 批次 D（92 文件 / 1133 用例）
- F-13 内容可达：stairs_up/down_kit 配方（plank+stone）；门开合 = 新通用 SoA `Passage{open}`
  + interaction 切换 + 碰撞/A*/视线/投射物同源跳过；`Passage.open` 入档并进 netSync 动态 key；
  wall_upper 接入 building-demo 并补 Health。
- F-12 防御结构：fence/door 加 Health + Structure(role=wall)；A* 阻挡索引纳入
  Structure 墙与 Placeable.canCollide+Collider 的建造物；raid 结构目标自然覆盖；开门跳过。
- F-14 projectile：game.json 启用 projectile（排在 collision 后）；新增 throwing_spear
  物品（ItemKind.throw 档案：speed/lifeMs/radius/cooldown/damage）与配方；`throwWeapon`
  原子（冷却/方向解析/生成/磨损），命中按标准公式扣血并发 on-hit/killed/on-contact；
  方向复用 PlayerCommand 的 x/y 世界坐标（新命令 "throw"，无 schema 断代）；顺带兑现
  投射物被建造墙阻挡（built.walls）。
- F-20 new-game 生成合法 pipeline（noise-terrain→climate-regions→region-stats）+ 出生规则，
  临时目录实测 validate 通过；README 同步。
- F-21 PlaceRuleSchema / ProgressionRuleSchema 注册；progression 运行时解析改为复用
  schema（单一事实来源）。
- F-34 rocky wolf every→900（保留 max 1 + isNight），测试证明夜间产出 1 只且不超上限。
- F-35 ResourceNode.infinite（采集不扣减、不枯竭）替代 water_pool 9999；
  LightSource.fuelInfinite（在线/离线不燃烧、站点可用）替代 campfire 1e9。
- F-36 validate 文案改为"实体演化规则（配置）…运行时另按 ecosystems 展开追加"。

### 批次 E（96 文件 / 1176 用例）
- F-10 死亡回写：deathSystem 非玩家死亡、destroyEntity 之前调 `recordPopulationDeath`——
  species + EntityMap + homeRegion 严格匹配，多节点取最近（同距取最小 eid），count−1
  下限 0；玩家/来源实体自身/无 Kind 不参与。node 模型目标随 count 下降，下一槽按
  growthRate 回补（不再瞬满）。Nest/Population 双通路收敛为「node 优先」：同时挂载时
  nestSystem 只镜像 current、不补足；纯 Nest 物种保持原语义。
- F-11 离线成本：每规则连续失败槽上限 64（可覆盖），达到即跳到区间末尾；`need≤0`
  不计失败；spawnExact 告警按 map+rule+kind+落点+reason 每进程去重。证据：24h 离线、
  every=20、不可落位规则的 canPlace 调用从约 276 万降到 2,048（64×32）。
- F-15 季节派生：`effectiveGroundAt/deriveEffectiveGround` 纯函数（底板语义+相位/进度+
  level+区域+hash→有效语义），`groundOverrides` 配置支持雪线（minLevel/进度窗口）、
  斑驳（coverage+hash）、区域包含/排除，链式顺序；不写回/不落盘/确定性。StateMachine
  定时迁移支持 `scale:"growthScale"`（区间积分，跨相位连续；未声明零变化），
  berry_bush 再生接入；离线快进与逐 tick 同一函数（等价断言）。
