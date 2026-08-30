# 通用 2D 游戏框架系统路线图

> 目标：将当前框架演进为通用 2D 游戏框架。
> Phase 0（切片前止血）已完成 5 个框架级缺陷修复；Slice 1（生存循环）、Slice 2（战斗闭环）、Slice 3（合成与装备）、Slice 4（世界氛围）、Slice 5（联机完整度）、Slice 6（建造与场景切换）、Slice 7（社交进度）、Slice 8（per-player 地图）与地图系统重设计（MapGeometry 五层架构）已完成。
> 现状：16 个内置系统（spawningSystem 已退役——实体生产职责移交地图演化引擎，见下文地图系统重设计条目）；crafting / placeable / deconstruct / dialogue 为命令驱动的原子模块（无 tick 体，inventoryOps 先例）；persistence / interest / 输入校验为仿真层能力（定时存档 / 视野裁剪 / 输入拦截——异步 I/O 与输入校验不入 ECS tick 系统）。
> 详见下文「已有系统状态」。

## 一、核心仿真
- Transform / Physics / Movement / Collision — 位置、速度积分、碰撞检测与分离
- Animation / Sprite — 帧动画状态机、精灵渲染数据
- Pathfinding（寻路） — A* 算法在网格上规划可绕障路径
- Steering（操控行为） — 分离、聚合、跟随、避让等群体移动

## 二、AI
- BehaviorTree（行为树） — 按优先级顺序选择动作分支
- UtilityAI（效用 AI） — 根据需求/环境评分动态选最优动作
- StateMachine（状态机） — 有限状态间切换驱动行为
- GOAP（目标导向动作规划） — 反推动作序列达成目标
- Perception / Sensor / Memory — 感知视野内实体、记忆历史事件

## 三、战斗
- Combat（伤害/射程/范围） — 攻击距离、扇形/圆形范围判定
- Health / Death — 生命值衰减与死亡清理
- Skill / Cooldown — 技能释放与冷却计时
- StatusEffect / Buff / Debuff — 持续性状态效果（中毒、加速等）
- Spawning（生成） — 按规则在区域内动态生成实体

## 四、生存
- Needs（需求） — 饥饿、口渴、体力、睡眠等持续衰减指标
- DayNightCycle（昼夜循环） — 时间推进与光照变化
- Weather（天气） — 雨/雪/雾，影响采集与生存
- Temperature（温度） — 体温/环境温度影响生存衰减

## 五、经济与物品
- Inventory / Equipment — 背包槽位管理与穿戴装备
- Crafting / Recipe（合成/配方） — 多材料组合产出新物品
- Loot / Drop — 击杀/采集掉落物
- Shop / Trade / Economy — 交易、商店、货币流通
- ResourceNode（采集点） — 可被采集并消耗的资源节点

## 六、社交与进度
- Relationship（N:N 关系图） — 实体间好感度/敌对度边权
- Dialogue（对话） — 分支对话树与选项
- Quest / Mission — 任务接取、进度、完成
- Faction / Reputation — 阵营归属与声望值
- Achievement（成就） — 解锁条件检测与记录
- Progression（等级/经验） — 经验积累与等级提升

## 七、建造与世界编辑
- Building / Placement — 玩家放置建筑/家具
- GridOccupancy（网格占用） — 标记格子是否被占用
- Interactable / Furniture — 可交互物体与家具属性
- Portal / Door（场景切换） — 区域/场景间传送

## 八、网络与服务端
- Sync（状态同步） — 服务端权威状态推送客户端
- InterestManagement（兴趣管理） — 视野裁剪，只同步附近实体
- LagCompensation / Reconciliation — 延迟补偿与客户端预测回滚
- Persistence / SaveLoad — 持久化到数据库与加载
- Matchmaking / Room — 匹配与房间管理
- AntiCheat / Validation — 输入合法性校验
- Telemetry / Metrics / Replay — 遥测、性能指标、回放

## 九、输入与控制
- InputMapping / Keybind — 按键映射到游戏动作
- CommandQueue / ActionQueue — 玩家指令排队依次执行
- Selection / GroupControl — 单选/框选/多单位控制
- Camera（相机） — 视角跟随、缩放、边界限制

## 十、元系统
- Audio — 音效/音乐播放与 3D 听觉
- Particle / VFX — 粒子特效数据
- UI / HUD — 界面元素与状态显示
- Localization / I18n — 多语言文本
- Settings / Options — 画质/音量/控制偏好
- Modding / Scripting — 玩家模组与脚本扩展
- DebugTools / Cheats — 调试快照、作弊指令

---

## 当前框架覆盖

### ✅ 已有
- physics、movement、collision、ai(BT 绑定 action + condition)
- combat（Slice 2 重构：`attackTarget` 攻击原子（射程/冷却/友伤/公式），不再自动攻击；BT Attack 与玩家 attack 意图共用）、spawning（**已退役**——旧 spawningSystem 及其 SpawnRule 配置随地图系统重设计删除，实体生产职责移交地图演化引擎，见下文「地图系统重设计」）
- perception（Slice 2：视野内最近敌对写黑板 `perception.target`，供 BT 决策）
- death / respawn（Slice 2：统一死亡处理——LootTable 掷骰掉落 + 非玩家移除 + 玩家原地重生（标记→重置 Health/位置/Needs，同 networkId））
- needDecay（Slice 1：按名衰减 Needs + 归零扣 Health；Slice 2 起不再自行移除，死亡统一归 deathSystem）
- gathering（Slice 1：资源节点采集 + 再生；directConsume / 部分入落地）
- interaction（Slice 1：意图路由按 range 找最近 Resource 调 harvest；Slice 2 加 attack 路由）
- inventory（Slice 1：堆叠拾取 + 服务端原子 transfer/drop/consume + pickupAfterMs 防瞬回）
- equipment（Slice 3：equipSlot 穿戴原子 + getEquipModifiers 加成读取（on-read，组件值不变）+ tick 体槽位引用卫生；加成经 ItemKindSchema.equip 声明）
- crafting（Slice 3：craftRecipe 原子模块，PlayerCommand `craft` 驱动；站类型/距离校验、缺料/满包拒零副作用、dry-run 防满包丢产出；recipes 经 CraftingRuleSchema 校验 + validateIntegrity 引用检查）
- dayNight（Slice 4：dayNightCycleSystem 推进 world.time.timeOfDay（hour/phase 二进制）；DayNightRuleSchema 校验；RoomState hour/phase 同步）
- spawning condition（Slice 4：SpawnRuleJson 可选 `condition` 字段 → spawnConditions 注册表（isNight 内建）；condition 不满足不刷但不重置计时器；validateIntegrity 校验。**现状**：SpawnRule 已随 spawningSystem 退役删除，condition 门控机制由 EntityRule.condition 继承——经同一 spawnConditions 注册表求值，每 evolve 调用一次）
- placeable（Slice 4：placeEntity 原子模块，PlayerCommand `place` 驱动；ItemKindSchema.place 声明目标 archetype；距离（rules/place.json）/实体重叠/地图阻挡校验零副作用 → 消耗 1 → spawn）
- 光源机制（Slice 4）：LightSource（radius/fuelRemainingMs，≤0 熄灭）+ Placeable（footprintW/H/canCollide）；火光回避 = 感知侧通用约定（目标在有效光源半径内不可感知）
- AoS 组件家族（Inventory / Kind / Needs / ResourceNode / ItemMeta / Intent / LootTable）+ spawn AoS 初始化钩子（Inventory/Needs/ResourceNode/LootTable 注册了钩子；ItemMeta/Intent/Kind 由运行时写入）
- SoA 组件补充（Slice 3/4）：Equipment（weapon/tool/armor 三槽引用 inventory 槽 idx，-1=空）、CraftingStation（stationType: ui32，0=通用手搓）、LightSource、Placeable
- BT 通用节点（Slice 2/4）：conditions IsTargetInVision/InAttackRange/IsNight/IsInLight + actions Chase/Flee/Attack/Sleep（Sleep 为 SUCCEEDED 语义——树每 tick 重置，条件变化即时改判；ActionFactory 放宽为 `State | boolean`；btFactory/validateIntegrity 支持 mistreevous while/until guard 条件收集（单对象形态））
- items 加载段（game/items/*.json + ItemKindSchema，Slice 3 加 equip 穿戴效果，Slice 4 加 place 放置声明）+ 通用规则 schema 注册表（combat/needs/crafting/daynight/server）
- sync：netSync OR 语义 + AoS 适配器（numbers/strings 分流，修旧 AND-query 缺陷）
- persistence（Slice 5）：worldSerializer（serializeWorld/restoreWorld——SoA+AoS 全量 + world 级状态，瞬态组件跳过，networkId 保真）+ Repository 接口（WorldRecord）+ createFileRepository 真实现（postgres/redis 适配接口留 stub 等真实需求）；GameSimulation 定时存档（rules/server.json saveIntervalMs）+ 读档恢复（玩家实体 addPlayer 复用绑定）
- interest management（Slice 5）：computeInterest 仿真层裁剪（viewRadius，own 恒可见）→ TickResult.interest → GameRoom 双路径（有裁剪写 per-client PlayerState.visibleEntities 增量同步；无裁剪走 RoomState.entities 全量广播，兼容旧协议）
- anti-cheat（Slice 5）：inputValidation 输入校验——maxMoveSpeed 超速输入被拒不推进 seq + maxCommandsPerSec 命令频率按 tick 滑动窗口限流，被拒记日志；无规则全放行
- server 规则（Slice 5）：game/rules/server.json + ServerRuleSchema（saveIntervalMs / saveId / viewRadius / maxMoveSpeed / maxCommandsPerSec）
- 静态碰撞（Slice 6）：collisionSystem 按 hasComponent(Velocity) 判静态——无 Velocity 实体（建筑/资源）注册 isStatic body 不被推开（墙阻挡玩家，修复放置物被顶走潜伏缺陷）
- building（Slice 6）：placeEntity 扩展——rules/place.json gridSnap（配置开关，缺省 false）网格对齐（占位矩形四角落格线）+ GridOccupancy 格组写入与占用冲突校验（同格重放拒、无缝拼接）+ Placeable.ownerNetworkId 所有权写入；deconstructEntity 拆除原子（仅放置者可拆、范围校验、不返还材料），PlayerCommand `deconstruct` + target
- GridOccupancy / Portal 组件（Slice 6）：GridOccupancy SoA（cellX/cellY/cellW/cellH）；Portal AoS（targetMap/x/y + 初始化钩子 + netSync 适配器）
- portal（Slice 6）：portalSystem tick（玩家 AABB 相交触发）+ switchMap 原子——setWorldMap（换图 + systemRuntimes 缓存重建）/ enterMap（清场保留玩家内容 Player/Placeable/ItemMeta + 按新图布置 + 传送）；loadGameDefinition 解析全部地图（resolvedMapSources）；WorldRecord.mapId + 读档切回；TickSnapshot/RoomState.mapId；SpawnRule.mapId 限定生效地图；房间级切图语义（全员换图）
- 帧内事件总线（Slice 7）：world.runtimeEvents + emitEvent/consumeEvents（step 帧首清空）；combatSystem 致命一击 emit `killed`（killer/victim/kind）
- dialogue（Slice 7）：dialogueSystem 原子模块——startDialogue（talk 意图路由 NPC）/ advanceDialogue（PlayerCommand `dialogue`）+ 选项效果（quest_accept/quest_submit/relation_delta，失败不推进）；Dialogue AoS 组件挂玩家（瞬态会话，netSync 同步选项文本）；DialogueSource AoS 挂 NPC（treeId）
- quest（Slice 7）：questSystem tick 体（collect 背包计数 / kill 击杀事件计数，ACTIVE→READY）+ accept/submit 原子（collect 消耗 + 奖励 dry-run + 好感 + DONE）；Quest AoS 组件挂玩家（持久入档）；game/dialogues/*.json + game/quests/*.json 配置段 + validateIntegrity 引用校验
- relation（Slice 7）：Relation AoS 组件挂玩家（npcKind/value，持久入档）+ addRelation/getRelation 原子；任务提交/对话效果写入
- PlayerInput.talk（Slice 7）：新对话意图（talk）→ interactionSystem 路由最近 NPC；GameRoom isPlayerInput/isPlayerCommand 白名单扩展
- 地图系统重设计（MapGeometry 五层架构，详见「已有系统状态」）：
  - geometry 数据层（MapGeometry 不可变几何 + walkableAt/regionOf/tileAt 纯函数查询 + serializeGeometry/deserializeGeometry 快照 + fnv1a32 内容指纹 version）
  - generate 生成层（GeometryDraft/GenerationContext + buildMapGeometry(config, registry) 管道执行器 + validate 结构校验 + 生成积木注册表 + xmur3/mulberry32 种子派生；内置四积木 noise-terrain / climate-regions / room-corridor / tiled-source）
  - evolution 演化层（EntityRule density/exact/template/condition + pickPoint 确定性选点（候选序列纯函数 + 32 次上限）+ evolve 补差引擎（槽绝对对齐、(from, to] 边界、只增不删早退、template 整组原子））
  - runtime 运行时（bootMaps 开机唯一分支地 + 引用校验（含 portal 配对 Chebyshev ≤ 2）+ pickSpawnPosition 出生服务 + clock 离线折算 + evolveDeps 真实依赖装配）
  - 持久化集成（WorldRecord.maps 地理快照与实体同盘 + 离线补差 computeOfflineTicks → 单次 evolve → advanceTickTo）
  - 网络接口（/maps/meta + /maps/runtime 由 MapGeometry 提供数据，x-map-version 缓存头，未知图 404）
- logger

### ❌ 缺口最大三类
1. **AI 高级决策** — UtilityAI、StateMachine、GOAP（Perception 已落地 S2）
2. **网络服务端** — Persistence / InterestMgmt / AntiCheat 已落地 S5；LagComp 未做
3. **社交进度** — Relationship、Dialogue、Quest、Achievement、Progression

> **对账注记（追加补充，不覆盖原文）**：第 3 类为撰写时快照——S7 已完成
> **Dialogue（对话树）/ Quest（collect+kill 双形态）/ Relation（好感）**；
> 剩余缺口为 **Achievement / Progression / Faction**（见 PLAN「后续候选」表）。

### 🔧 已有系统状态

> Phase 0（切片前止血）已完成 5 个框架级缺陷修复：combat 射程判定、spawning 按 kind/多边形过滤、inventory 满包吞物品、systemRegistry before 语义、btFactory condition 收集。
>
> **Slice 1（生存循环）已完成**：玩家持续衰减的 Needs，采集食物补给否则饿死。验收 `pnpm test`（73 项）+ `tsc --noEmit` + `pnpm tools validate` 全绿，`framework/` 游戏词 grep 空。
>
> **Slice 2（战斗闭环）已完成**：boar 感知→追击→攻击，玩家 attack 意图近战反击，击杀掉肉，玩家死亡自动重生。验收 `pnpm test`（102 项）+ `tsc --noEmit` + `pnpm tools validate` 全绿，`framework/` 游戏词 grep 空。下一切片为 Slice 3 合成与装备。
>
> **Slice 3（合成与装备）已完成**：采集石头/木头 → 合成工具（gatherMult×2）/武器（attackBonus）→ 装备生效；cooked_meat 需火堆站点；缺料/满包/站点校验零副作用。验收 `pnpm test`（128 项）+ `tsc --noEmit` + `pnpm tools validate` 全绿，`framework/` 游戏词 grep 空。下一切片为 Slice 4 世界氛围。
>
> **Slice 4（世界氛围）已完成**：昼夜循环（dayNightCycleSystem + world.time.timeOfDay 同步到 RoomState）；夜间条件刷怪（SpawnSchema.condition + isNight）；火光回避（感知侧：光内目标不可感知 + 光内入睡 BT）；玩家放置火堆（campfire_kit → place 命令 → Placeable/campfire 实体 + 站点合成）。审查修复：Sleep 改 SUCCEEDED（RUNNING 记忆导致的睡死/追击残留根治）、wolf-night 追击分支 while IsNight guard（天亮停手）、validateIntegrity 行为树校验修复（原空转）、guard 单对象清理。验收 `pnpm test`（155 项）+ `tsc --noEmit` + `pnpm tools validate` 全绿，`framework/` 游戏词 grep 空（blackboard 技术词除外）。下一切片为 Slice 5 联机完整度。
>
> **Slice 5（联机完整度）已完成**：持久化（worldSerializer 世界快照 + Repository/WorldRecord 接口 + createFileRepository 真实现，postgres/redis 适配接口留 stub；GameSimulation 定时存档 saveIntervalMs + 读档恢复 + 玩家 addPlayer 复用绑定，networkId 保留）；兴趣管理（computeInterest 按 viewRadius 裁剪、own 恒可见；GameRoom 双路径——有规则写 per-client PlayerState.visibleEntities，无规则保留 RoomState.entities 全量广播兼容旧协议）；输入校验（maxMoveSpeed 超速拒 + maxCommandsPerSec 命令频率 tick 窗口限流，被拒记日志）。server 规则经 ServerRuleSchema 校验。审查修复：兴趣裁剪 per-client 用 schema 4 `$filter` 实例级过滤（VisibleEntities 子类 + client.view 挂 sessionId）、destroyEntity 统一实体销毁（AoS 残留清理防存档污染）、存档畸形防御与写盘串行化、频率窗口 off-by-one、NetworkId 入瞬态名单。验收 `pnpm test`（173 项）+ `tsc --noEmit` + `pnpm tools validate` 全绿，`framework/` 游戏词 grep 空（blackboard 技术词除外）。核心 Demo 至此贯通。
>
> **Slice 6（建造与场景切换）已完成**：静态碰撞修复（无 Velocity 实体注册静态碰撞体——墙不被玩家顶走，建造前置）；建造闭环（placeEntity 扩展：gridSnap 网格对齐 + GridOccupancy 格组占用校验/写入 + Placeable.ownerNetworkId 所有权；deconstruct 拆除原子——仅放置者可拆，PlayerCommand `deconstruct` + target）；场景切换（Portal AoS 组件 + portalSystem tick + switchMap 原子 setWorldMap/enterMap——清场保留玩家内容 Player/Placeable/ItemMeta、按新图布置、传送玩家、地图相关缓存选择性重建；loadGameDefinition 多地图解析 resolvedMapSources；WorldRecord.mapId 存档 + 读档切回；TickSnapshot/RoomState.mapId + GameRoom 换图强制重拉碰撞体；SpawnRule.mapId 限定生效地图）。game：wall/floor/door/fence/furniture/portal/portal_back + 5 个 kit 物品与配方 + place.json gridSnap + cave 地图 + 分图 populations。审查修复：portal 触发死锁（严格小于触发判定与 SAT 分离互斥——portal 去 Collider + 接触判定 <= + 完整 tick 链集成用例）、换图缓存改选择性重建（保留 death 重生标记）、读档地图无效告警。验收 `pnpm test`（187 项）+ `tsc --noEmit` + `pnpm tools validate` 全绿，`framework/` 游戏词 grep 空（blackboard 技术词除外）。（**状态注记**：本切片的房间级切图语义（setWorldMap/enterMap 全员换图）、SpawnRule.mapId、分图 populations 配置与 WorldRecord.mapId 回退，已被后续 Slice 8（per-player 化）与地图系统重设计**取代并删除**；静态碰撞、建造闭环与 portal per-player 触发保留至今。）
>
> **Slice 7（社交进度）已完成**：对话（dialogueSystem 原子模块——startDialogue/advanceDialogue + 选项效果 quest_accept/quest_submit/relation_delta，失败不推进；Dialogue AoS 瞬态会话组件挂玩家 + DialogueSource AoS 挂 NPC；PlayerInput.talk 新交互键 + interactionSystem talk 路由 + PlayerCommand `dialogue`）；任务（questSystem——collect 背包计数/kill 击杀事件计数两种目标形态，accept/submit 原子：collect 消耗 + 奖励 dry-run + 好感 + DONE；Quest AoS 持久组件挂玩家；game/dialogues + game/quests 配置段 + validateIntegrity 引用校验）；好感（Relation AoS 持久组件 + addRelation/getRelation）；帧内事件总线（world.runtimeEvents + emitEvent/consumeEvents，combatSystem 致命一击 emit killed 事件）。game：villager 对话树（接/交任务）+ quests.json（collect_axe/hunt_task）+ netSync 4 条。审查修复：对话选项 to 引用校验（validateIntegrity + 运行时先解析目标再执行效果，无效 to 停留不关会话）、AoS 适配器快照断言补强。faction/achievement/progression 记录不修（无真实需求牵引）。验收 `pnpm test`（199 项）+ `tsc --noEmit` + `pnpm tools validate` 全绿，`framework/` 游戏词 grep 空（blackboard 技术词除外）。下一切片按需开启。
>
> **Slice 8（per-player 地图）已完成**：每玩家地图归属（EntityMap AoS 组件 + `entityMapOf(world, eid)` 回退默认图——实体按所属地图分区：同图互相可见/交互/共享生态，跨图不可见/不可碰撞/不可互伤/不可交互/不可拾取；世界保持单一共享 ECS，**非每玩家私有世界副本**）。常驻模拟（`world.activeMaps` 里的图即使无玩家也照常运行碰撞/刷怪系统；地图经 `world.maps` 惰性构建缓存 + `ensureMapActive` 激活，不开机预建全部图）。协议断代（`PlayerState.mapId` 同步玩家当前地图；`RoomState.mapId/entities` 移除、实体同步恒走 per-client `PlayerState.visibleEntities`——旧客户端不兼容）。持久化分图（实体地图按 `EntityMap` 入档/恢复，恢复后按实体归属激活各图；`WorldRecord.mapId` 降级为旧档迁移回退——新档实体归属以 `components["EntityMap"]` 为准）。portal 触发改 per-player（同图相交只移动触发玩家，无乒乓冷却——最小实现原则记录为已知行为）。验收 `pnpm test`（30 文件 330 项全通过——已含 16 个 per-player 新测试文件，房间级旧语义用例已翻转）+ `tsc --noEmit` + `pnpm tools validate` 全绿，`framework/` 游戏词 grep 空（blackboard 技术词除外）。
>（**状态注记**：本切片的地图生命周期语义——`ensureMapActive` 惰性构建、`spawnInitialNpcs` 布置、`WorldRecord.mapId` 回退——已被下文「地图系统重设计」**取代并删除**；per-player 归属（EntityMap/entityMapOf）与协议断代语义保留至今。）
>
> **地图系统重设计（MapGeometry 五层架构）已完成**：旧地图系统（MapRuntime/buildRuntime/generatorRegistry 旧表/registerGenerator 公共 API/`game/spawns/populations.json`/spawningSystem）**全部删除**（393d058），替换为五层架构——
> - **geometry 数据层**：不可变 `MapGeometry`（key/grid/tiles/walkable/regions/regionOfTile/version）；regions Map 插入序 = regionOfTile 索引序；`walkableAt/regionOf/tileAt` 纯函数查询（越界安全）；`serializeGeometry/deserializeGeometry` 纯 JSON 快照；`computeGeometryVersion` fnv1a32 内容指纹（8 位十六进制，key 与 version 不参与）。
> - **generate 生成层**：`GeometryDraft`（可变草稿）→ 管道执行器 `buildMapGeometry(config, registry)`（每步从 seed+步骤序号派生独立随机流）→ `validateMapGeometry` 出口结构校验 → 冻结 + 指纹；生成积木注册表（名 → `(ctx: GenerationContext) => void`）；内置四积木：noise-terrain（bandLevel+groundPalette+nonWalkableSemantics）、climate-regions（names[] 序 = 区域索引序，隐式 wilderness）、room-corridor（地形级雕挖 + union-find 连通）、tiled-source（Tiled JSON 加载期内联降级为积木，积木无文件 I/O）。
> - **evolution 演化层**：`EntityRule`（map/region/kind/max/every/mode=density|exact|template/condition/template/at）补差引擎——槽绝对对齐 timeSlot、(from, to] 槽边界、只增不删早退不变式、template 整组原子；`pickPoint` 候选序列是 (seed, mapKey, ruleId, timeSlot) 纯函数 + 32 次尝试上限。
> - **runtime 运行时**：`bootMaps` 开机唯一分支地（有档按快照回填 / 无档生成 + 初始演化 0 → initialAgeTicks；全图常驻 activeMaps）+ 引用校验（规则 kind/region/map、exact 落点可走、portal 配对 Chebyshev ≤ 2）+ 首份 WorldRecord 装配；`pickSpawnPosition`（random/seededRandom/exact，像素坐标）；`clock.ts` 复用 world.time.tick + `computeOfflineTicks`；`evolveDeps.ts` 真实依赖装配（tile↔像素换算）。
> - **核心切换**：`createGameSimulation` 改 async（BootDeps { loadRecord, saveRecord } 单一读档通道）；GameInstance.beforeSystems 演化钩子（tick 自增后、系统循环前，`evolve(tick-1, tick)`）；spawningSystem 退役（实体生产唯一路径 = 演化引擎，开机初始演化/每 tick 补差/离线补差共用同一引擎）；出生走规则服务并持久化出生点（SpawnPoint AoS 组件）；`game/maps/entity-rules.json` 新配置段（16 条规则，wolf isNight + 配对传送门）。
> - **持久化**：`WorldRecord` 新增 `maps`（SerializedMapGeometry，地理快照与实体同盘），复用 savedAt/tick/timeOfDay，旧 `mapId` 字段删除；离线补差 = `computeOfflineTicks`（上限 `DEFAULT_MAX_OFFLINE_TICKS = 1,728,000` ≈ 24h@20tps，截断 + 告警）→ 单次 evolve → `advanceTickTo` 落边界；旧存档直接废弃，无兼容代码。
> - **网络接口**：/maps/meta 与 /maps/runtime 由 MapGeometry 提供数据（`x-map-version` 缓存响应头，未知图 404，缺省回退默认图）。
> - **工具链**：gen-map（管道 JSON 快照）/ export-map（真实开机 + JSON+PNG，色表为工具参数）/ validate（每图管道链 + 实体规则数）/ list-registries（「生成积木」段）；`registerGenerator`/`listRegisteredGenerators` 公共 API 删除，自定义积木经 `getRegistries().mapGeneratorRegistry.register()` 注册。
> - **已知局限（潜在，未触发）**：template 规则锚点跨区域计数边界——spawnTemplate 只校验偏移格可走/未占（可落出 rule.region），而 countByKind 按区域计数，锚点落出区域时每次 evolve 调用会误判「低于 max」再补一组（跨调用无界增长）。当前游戏配置无 template 规则，触发前无影响；修复方向 = 锚点限定区域内或 template 锚计数改全图。
> - 验证：最终验证波 F1–F4 全部 APPROVE；`pnpm test` 452/452 绿（41 文件，U1–U7/I1–I5 编号覆盖矩阵）+ `pnpm build` + `pnpm tools validate` 全绿；旧符号残留 grep（MapRuntime/ensureMapActive/spawnInitialNpcs/world.map 等）零命中。

**切片内待补全（非框架缺陷）**：
- （已补全）inventorySystem：堆叠/丢弃/使用已落地（Slice 1）
- （已补全）interactionSystem：意图路由已落地（Slice 1）
- （已补全）deathSystem / respawn / loot：已落地（Slice 2，loot 并入 deathSystem）
- （已补全）equip 原子：已落地（Slice 3，equipSlot + on-read 加成修正）
