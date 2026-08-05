# 通用 2D 游戏框架系统路线图

> 目标：将当前框架演进为通用 2D 游戏框架。
> Phase 0（切片前止血）已完成 5 个框架级缺陷修复；Slice 1（生存循环）、Slice 2（战斗闭环）、Slice 3（合成与装备）与 Slice 4（世界氛围）已完成。
> 现状：8 个内置核心系统 + Slice 1 新增 2 个生存系统（needDecay / gathering）+ Slice 2 新增 3 个系统（perception / death / respawn）+ Slice 3 新增 1 个系统（equipment）+ Slice 4 新增 1 个系统（dayNight），共 15 个内置系统；crafting / placeable 为命令驱动的原子模块（无 tick 体，inventoryOps 先例）。
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
- BT 通用节点（Slice 2/4）：conditions IsTargetInVision/IsTargetNotInVision/InAttackRange/IsNight/IsInLight + actions Chase/Flee/Attack/Sleep（ActionFactory 放宽为 `State | boolean`；btFactory/validateIntegrity 支持 mistreevous while/until guard 条件收集）
- items 加载段（game/items/*.json + ItemKindSchema，Slice 3 加 equip 穿戴效果，Slice 4 加 place 放置声明）+ 通用规则 schema 注册表（combat/needs/crafting/daynight）
- sync：netSync OR 语义 + AoS 适配器（numbers/strings 分流，修旧 AND-query 缺陷）
- logger

### ❌ 缺口最大三类
1. **AI 高级决策** — UtilityAI、StateMachine、GOAP（Perception 已落地 S2）
2. **网络服务端** — InterestMgmt、LagComp、Persistence、AntiCheat
3. **社交进度** — Relationship、Dialogue、Quest、Achievement、Progression

### 🔧 已有系统状态

> Phase 0（切片前止血）已完成 5 个框架级缺陷修复：combat 射程判定、spawning 按 kind/多边形过滤、inventory 满包吞物品、systemRegistry before 语义、btFactory condition 收集。
>
> **Slice 1（生存循环）已完成**：玩家持续衰减的 Needs，采集食物补给否则饿死。验收 `pnpm test`（73 项）+ `tsc --noEmit` + `pnpm tools validate` 全绿，`framework/` 游戏词 grep 空。
>
> **Slice 2（战斗闭环）已完成**：boar 感知→追击→攻击，玩家 attack 意图近战反击，击杀掉肉，玩家死亡自动重生。验收 `pnpm test`（102 项）+ `tsc --noEmit` + `pnpm tools validate` 全绿，`framework/` 游戏词 grep 空。下一切片为 Slice 3 合成与装备。
>
> **Slice 3（合成与装备）已完成**：采集石头/木头 → 合成工具（gatherMult×2）/武器（attackBonus）→ 装备生效；cooked_meat 需火堆站点；缺料/满包/站点校验零副作用。验收 `pnpm test`（126 项）+ `tsc --noEmit` + `pnpm tools validate` 全绿，`framework/` 游戏词 grep 空。下一切片为 Slice 4 世界氛围。
>
> **Slice 4（世界氛围）已完成**：昼夜循环（dayNightCycleSystem + world.time.timeOfDay 同步到 RoomState）；夜间条件刷怪（SpawnSchema.condition + isNight）；火光回避（感知侧：光内目标不可感知 + 光内入睡 BT）；玩家放置火堆（campfire_kit → place 命令 → Placeable/campfire 实体 + 站点合成）。验收 `pnpm test`（155 项）+ `tsc --noEmit` + `pnpm tools validate` 全绿，`framework/` 游戏词 grep 空（blackboard 技术词除外）。下一切片为 Slice 5 联机完整度。

**切片内待补全（非框架缺陷）**：
- （已补全）inventorySystem：堆叠/丢弃/使用已落地（Slice 1）
- （已补全）interactionSystem：意图路由已落地（Slice 1）
- （已补全）deathSystem / respawn / loot：已落地（Slice 2，loot 并入 deathSystem）
- （已补全）equip 原子：已落地（Slice 3，equipSlot + on-read 加成修正）
