# 通用 2D 游戏框架系统路线图

> 目标：将当前框架演进为通用 2D 游戏框架。
> Phase 0（切片前止血）已完成 5 个框架级缺陷修复；Slice 1（生存循环）、Slice 2（战斗闭环）、Slice 3（合成与装备）、Slice 4（世界氛围）、Slice 5（联机完整度）、Slice 6（建造与场景切换）与 Slice 7（社交进度）已完成。
> 现状：8 个内置核心系统 + Slice 1 新增 2 个生存系统（needDecay / gathering）+ Slice 2 新增 3 个系统（perception / death / respawn）+ Slice 3 新增 1 个系统（equipment）+ Slice 4 新增 1 个系统（dayNight）+ Slice 6 新增 1 个系统（portal）+ Slice 7 新增 1 个系统（quest），共 17 个内置系统；crafting / placeable / deconstruct / dialogue 为命令驱动的原子模块（无 tick 体，inventoryOps 先例）；persistence / interest / 输入校验为仿真层能力（定时存档 / 视野裁剪 / 输入拦截——异步 I/O 与输入校验不入 ECS tick 系统）。
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
- combat（Slice 2 重构：`attackTarget` 攻击原子（射程/冷却/友伤/公式），不再自动攻击；BT Attack 与玩家 attack 意图共用）、spawning（按 kind/多边形过滤已补齐，计数不限 NPC）
- perception（Slice 2：视野内最近敌对写黑板 `perception.target`，供 BT 决策）
- death / respawn（Slice 2：统一死亡处理——LootTable 掷骰掉落 + 非玩家移除 + 玩家原地重生（标记→重置 Health/位置/Needs，同 networkId））
- needDecay（Slice 1：按名衰减 Needs + 归零扣 Health；Slice 2 起不再自行移除，死亡统一归 deathSystem）
- gathering（Slice 1：资源节点采集 + 再生；directConsume / 部分入落地）
- interaction（Slice 1：意图路由按 range 找最近 Resource 调 harvest；Slice 2 加 attack 路由）
- inventory（Slice 1：堆叠拾取 + 服务端原子 transfer/drop/consume + pickupAfterMs 防瞬回）
- equipment（Slice 3：equipSlot 穿戴原子 + getEquipModifiers 加成读取（on-read，组件值不变）+ tick 体槽位引用卫生；加成经 ItemKindSchema.equip 声明）
- crafting（Slice 3：craftRecipe 原子模块，PlayerCommand `craft` 驱动；站类型/距离校验、缺料/满包拒零副作用、dry-run 防满包丢产出；recipes 经 CraftingRuleSchema 校验 + validateIntegrity 引用检查）
- dayNight（Slice 4：dayNightCycleSystem 推进 world.time.timeOfDay（hour/phase 二进制）；DayNightRuleSchema 校验；RoomState hour/phase 同步）
- spawning condition（Slice 4：SpawnRuleJson 可选 `condition` 字段 → spawnConditions 注册表（isNight 内建）；condition 不满足不刷但不重置计时器；validateIntegrity 校验）
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
- logger

### ❌ 缺口最大三类
1. **AI 高级决策** — UtilityAI、StateMachine、GOAP（Perception 已落地 S2）
2. **网络服务端** — Persistence / InterestMgmt / AntiCheat 已落地 S5；LagComp 未做
3. **社交进度** — Relationship、Dialogue、Quest、Achievement、Progression

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
> **Slice 6（建造与场景切换）已完成**：静态碰撞修复（无 Velocity 实体注册静态碰撞体——墙不被玩家顶走，建造前置）；建造闭环（placeEntity 扩展：gridSnap 网格对齐 + GridOccupancy 格组占用校验/写入 + Placeable.ownerNetworkId 所有权；deconstruct 拆除原子——仅放置者可拆，PlayerCommand `deconstruct` + target）；场景切换（Portal AoS 组件 + portalSystem tick + switchMap 原子 setWorldMap/enterMap——清场保留玩家内容 Player/Placeable/ItemMeta、按新图布置、传送玩家、地图相关缓存选择性重建；loadGameDefinition 多地图解析 resolvedMapSources；WorldRecord.mapId 存档 + 读档切回；TickSnapshot/RoomState.mapId + GameRoom 换图强制重拉碰撞体；SpawnRule.mapId 限定生效地图）。game：wall/floor/door/fence/furniture/portal/portal_back + 5 个 kit 物品与配方 + place.json gridSnap + cave 地图 + 分图 populations。审查修复：portal 触发死锁（严格小于触发判定与 SAT 分离互斥——portal 去 Collider + 接触判定 <= + 完整 tick 链集成用例）、换图缓存改选择性重建（保留 death 重生标记）、读档地图无效告警。验收 `pnpm test`（187 项）+ `tsc --noEmit` + `pnpm tools validate` 全绿，`framework/` 游戏词 grep 空（blackboard 技术词除外）。
>
> **Slice 7（社交进度）已完成**：对话（dialogueSystem 原子模块——startDialogue/advanceDialogue + 选项效果 quest_accept/quest_submit/relation_delta，失败不推进；Dialogue AoS 瞬态会话组件挂玩家 + DialogueSource AoS 挂 NPC；PlayerInput.talk 新交互键 + interactionSystem talk 路由 + PlayerCommand `dialogue`）；任务（questSystem——collect 背包计数/kill 击杀事件计数两种目标形态，accept/submit 原子：collect 消耗 + 奖励 dry-run + 好感 + DONE；Quest AoS 持久组件挂玩家；game/dialogues + game/quests 配置段 + validateIntegrity 引用校验）；好感（Relation AoS 持久组件 + addRelation/getRelation）；帧内事件总线（world.runtimeEvents + emitEvent/consumeEvents，combatSystem 致命一击 emit killed 事件）。game：villager 对话树（接/交任务）+ quests.json（collect_axe/hunt_task）+ netSync 4 条。审查修复：对话选项 to 引用校验（validateIntegrity + 运行时先解析目标再执行效果，无效 to 停留不关会话）、AoS 适配器快照断言补强。faction/achievement/progression 记录不修（无真实需求牵引）。验收 `pnpm test`（199 项）+ `tsc --noEmit` + `pnpm tools validate` 全绿，`framework/` 游戏词 grep 空（blackboard 技术词除外）。下一切片按需开启。

**切片内待补全（非框架缺陷）**：
- （已补全）inventorySystem：堆叠/丢弃/使用已落地（Slice 1）
- （已补全）interactionSystem：意图路由已落地（Slice 1）
- （已补全）deathSystem / respawn / loot：已落地（Slice 2，loot 并入 deathSystem）
- （已补全）equip 原子：已落地（Slice 3，equipSlot + on-read 加成修正）
