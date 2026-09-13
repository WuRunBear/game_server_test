# 玩法系统补充建议（借鉴 demo-e7ae1909）

## 一、背景与来源

来源：对纯前端地牢 roguelike `demo-e7ae1909`（元气骑士风格，Canvas 2D，位于 `/mnt/jixie/data/AI/project/game/demo-e7ae1909`）的只读源码调研——架构与地牢生成、玩法机制清点、本框架覆盖面 grep 核对各一份。本文档记录调研中确认**本框架缺失、且 demo 有成熟参照**的玩法层能力，作为后续切片的候选池。

与 `map-system-design.md` 的分工：地图生成相关（slot-rooms 槽位房间布局积木）已写入该文档提案 7；本文档只收录玩法/战斗/AI 层。双方唯一交叉点是房间流程（G6），它依赖提案 7 产出的 region 元数据。

## 二、现状基线（已核实）

| 能力 | 框架现状 | 证据 |
|------|---------|------|
| 攻击 | 瞬发 hitscan，`combatSystem.attackTarget`（framework/systems/gameplay/combatSystem.ts:68），伤害公式 max(1, 攻-防)（L101-115） | grep `projectile\|bullet\|missile\|arrow` 零命中；types.ts:34 注释自述"近战等" |
| 状态效果 | `Duration` 组件已注册但**零消费者**（仅 worldSerializer 瞬态跳过清单）；无 buff/poison/burn/slow/stun 概念 | grep `buff\|statusEffect\|poison\|burn\|stun\|slow` 零命中 |
| 技能/闪避 | PlayerCommand 仅 8 种（consume/drop/transfer/craft/equip/place/deconstruct/dialogue），PlayerInput 仅 moveX/moveY/interact/attack/talk（framework/simulation/types.ts L21/L52）；`Cooldown` 仅战斗使用 | grep `skill\|dodge\|dash\|ability` 零命中 |
| 武器模型 | `Attack` 组件仅 value/range；ItemKind 的 equip 仅 attackBonus/defenseBonus/gatherMult | 无 category/rarity/攻击模式字段 |
| 精英/缩放 | EntityRule 无任何缩放概念 | grep `boss\|elite\|精英` 零命中 |
| 房间流程 | 地图常驻全图模拟（bootMaps），演化引擎只做上限补足，无进入触发/清场判定 | grep `roguelike\|dungeon\|关卡\|波次\|wave` 零命中 |
| 货币/商店 | 完全没有 | grep `gold\|coin\|currency\|shop\|trade` 零命中 |
| Boss 能力 | BT 仅 6 动作 4 条件（Idle/Wander/Chase/Flee/Attack/Sleep + IsTargetInVision/InAttackRange/IsNight/IsInLight） | 无 telegraph/范围弹幕/召唤/阶段节点 |

另有三个"已注册但未接线"的陷阱，借鉴时不要误判为已实现：`Duration`（零消费者）、`AIState/Target/BlackboardRef`（全仓库无读写）、`Perception.hostilityRange`（组件注释自认占位）。

## 三、建议

### G1 投射物/弹道系统（最高优先）

- **现状**：见基线表第一行；攻击命中即扣血，无飞行过程。
- **demo 参照**：统一弹体结构（bullets.js spawn L11-19：x/y/vx/vy/r/dmg/team/life/pierce/elem/explode/homing/bounce，上限 460）；14 种开火原型（bullet/pellet/arrow/laserBolt/orb/beam/chain/rocket/grenade/shuriken/boomerang/flame/blackhole/melee）；49 把武器全部用同一套字段参数化（weapons.js LIST）。
- **实现方案**（第一步只做最小集）：
  1. 新增 SoA 组件 `Projectile`（ownerEid、team、damage、velocity、lifetime、pierce 最小集）+ `projectileSystem`：tick 移动 → tile 碰撞（经 `world.maps` walkable 查询，与 collisionSystem 同源）→ 命中判定（Team 不同 + 距离）→ 寿命销毁；netSync 按现有配置驱动机制同步。
  2. 伤害公式复用：把 attackTarget L101-115 的公式抽为纯函数（或 RuleModule），hitscan 与投射物共用，保证数值一致。
  3. PlayerInput 扩展瞄准方向（aimX/aimY 或 attack 携带方向），服务端权威校验射速（复用 Cooldown）。
  4. ItemKindSchema 的 equip 块扩展远程参数（projectile 原型/speed/range/pierce），攻击时按装备发射。
  - **首期不做**：beam/chain/homing/bounce 等 12 种原型；demo 全参数表留作后续扩展目录。
- **单测**：直线轨迹、墙体阻挡、命中扣血与 killed 事件、穿透计数、寿命销毁、射速限制、netSync 同步。

### G2 状态效果系统（激活 Duration）

- **现状**：`Duration` 组件零消费者（framework/components/timer.ts）。
- **demo 参照**：四元素效果（enemies.js update L409-422）——burn 170f、每 24f 结算 3+floor；poison 220f、每 30f 结算 2+0.7×floor；slow 130f、速度×0.45；stun 16f 停止 AI。施加点在伤害入口按 elem 分发。
- **实现方案**：
  1. 新增 `statusEffectSystem`（tick 系统）：遍历 `[Duration]` 递减，到期清零；效果定义走规则 JSON：`{ kind, durationMs, periodMs?, damage?, speedMul?, stun? }`。
  2. slow 挂 movementSystem 速度乘区；stun 门 aiSystem（有 stun 跳过行为树）；DoT 周期写 Health 并经 gameEvents emit 事件。
  3. 施加入口：combatSystem 命中后按攻击者配置的 elem 附加（demo 的 fire/ice/poison/shock）。
- **单测**：递减到零清除、DoT 周期数值、slow 改变移动、stun 抑制 AI、Duration 瞬态不入档（恢复后状态重建）。

### G3 技能/冷却/闪避

- **现状**：见基线表第三行；能量/资源概念缺失。
- **demo 参照**：8 个技能（player.js useSkill L97-172）= 冷却 240-420f + 能耗 26-50 + 效果；翻滚 = 13 帧位移 + 无敌帧 invT = 13+dashInv、CD 46f。
- **实现方案**：
  1. 技能 = 配置声明的"动作 + Cooldown + 可选资源消耗 + 可选效果引用（G1 投射物 / G2 状态效果）"。新增 `skill` 命令（PlayerCommand）+ 技能注册表（RuleModule 同款 名→factory），服务端校验冷却与资源。
  2. 闪避 = `dodge` 输入意图 + `Invulnerable`（SoA 剩余 ms）+ 位移脉冲（服务端校验位移距离上限与 CD）；受击判定前置 Invulnerable 检查（demo hurtPlayer L180 的 invT 判定）。
  3. 资源：新增通用 `Resource` 组件（或复用 Needs 模式），配置驱动上限/回复。
- **单测**：冷却窗口拒绝、资源不足拒绝、无敌帧免疫伤害、位移上限校验、瞬态不入档。

### G4 武器与攻击模式配置扩展

- **现状**：见基线表第四行。
- **demo 参照**：武器字段集（dmg/rate/n/spread/speed/pierce/energy/crit/style/elem/explode…）+ 11 类 cat + 5 级稀有度；掉落权重随进度偏置（weapons.js roll L97-108）。
- **实现方案**：ItemKindSchema.equip 扩展可选字段 `attack: { cooldownMs?, range?, projectile? }`、`category?`、`rarity?`（zod 校验，缺省行为与现状完全一致）；equipModifiers 聚合时纳入；掉落 rarity 偏置留到 G7 一并做。首期只做 G1 直线弹所需最小集。
- **单测**：缺省配置行为与现状逐字节一致（schema 向后兼容）、新字段聚合进攻击数值、非法值抛错。

### G5 精英与难度缩放

- **现状**：见基线表第五行；离线补差与每 tick 补差共用同一 evolve 引擎，缩放天然继承。
- **demo 参照**：make() 层缩放公式（enemies.js L51-68）：hpMul=(1+(floor-1)×0.42)×(elite?2.4:1)×(boss?1+(floor-1)×0.3:1)；dmgMul=(1+(floor-1)×0.2)×(elite?1.4:1)；精英掉落×2.2。demo 的"楼层"对应本框架的不同 map/region。
- **实现方案**：EntityRule 增可选字段 `scale?: { hp?, damage?, speed? }`（固定乘区）与 `elite?: { chance: number, mult: { hp, damage } }`（按概率生成精英变体，实体加 elite 标记供展示/掉落区分）；engine 在生成时乘算，zod 校验。
- **单测**：无新字段时与现状一致、scale 生效、elite 概率分布统计断言、同 seed 确定性。

### G6 房间战斗流程

- **现状**：见基线表第六行。
- **demo 参照**：房间状态机 idle→fighting→clear（game.js startFight L231-246 / clearRoom L247-263）：进入有 spawns 的房间→关门（门格写 blocked）→生成→房内敌人清空→开门+奖励（金币、40% 宝箱、30% 红心；Boss 房掉传送门+大宝箱）。
- **实现方案**：新增通用 gameplay 系统（如 roomFlowSystem）：
  1. 触发：玩家进入标记为 combat 类的 region（依赖 map-system-design.md 提案 7 的 region meta.type；无该积木的图不启用，或用 climate-regions 的 region 配置做降级版）。
  2. 封锁：按 region meta.doors 在门格生成临时障碍实体（或 collision 标记），离开即恢复。
  3. 刷怪：对该 region 的 EntityRule 立即补足到 max（复用 evolve）或模板生成。
  4. 清场：region 内敌对实体为 0 → 解锁 + 奖励掉落（复用 LootTable + spawnDroppedItem）+ 清场事件（供任务/统计扩展）。
  - 多玩家语义（demo 是单机）：缺省取"同图玩家共享房间状态"，实现时显式写死并在文档注明。
- **单测**：进入触发/离开重置、门格封锁生效、清场解锁、奖励数值、多人共享判定。

### G7 货币与商店

- **现状**：见基线表第七行。
- **demo 参照**：金币局内经济（敌掉/清房/宝箱），商店定价武器 40+rarity×14、遗物 85、治疗 35、祭坛 30（items.js interact）。
- **实现方案**（最小实现）：
  1. `Currency` AoS 组件（按 kind 计数，支持多种货币）+ 货币物品 kind（拾取入 Currency 而非背包）。
  2. 交易走 dialogueSystem 效果扩展（buy/sell 效果，对话树即商店界面）——零新 UI 协议，任务/对话基建现成；备选 `trade` 命令（PlayerCommand 扩展）留作后续。
- **单测**：货币增减原子性、余额不足拒绝、购买扣款+发货、货币不入背包。

### G8 Boss 行为能力（BT 扩展）

- **现状**：见基线表第八行；Chase 无寻路，感知纯圆形半径。
- **demo 参照**：3 个多阶段 Boss（enemies.js BOSSES L42-49）：acts 池随机选招（环形弹幕、召唤、冲撞、砸地、旋转激光、追踪导弹、布雷）；50% 血切 phase 2（速度×1.18、出招间隔×0.72、35% 连招）。
- **实现方案**（全部走 BT 注册表，零 BT 引擎改动）：
  1. 新动作：`windup`（前摇 N ms 后执行子动作 + telegraph 事件）、`shootRadial`（依赖 G1：n 发均分圆周）、`shootVolley`（扇形 n 发）、`summon`（按 template/原型在附近生成，数量上限）。
  2. 新条件：`hpBelow`（阈值百分比，阶段切换）。
  3. Boss = 普通实体 + 行为树配置（acts 池 = mistreevous 随机装饰器组合），数值走 G5 缩放。
- **单测**：前摇期间不动、出招后进 CD、radial 弹数与角度、召唤数量上限、hpBelow 只触发一次阶段切换。

## 四、依赖关系与切片顺序

- **G1 是地基**：G3（技能效果）、G8（弹幕 Boss）、G6（可选）都引用它。
- **G2、G4、G5 独立**：可先行，成本低（G4/G5 纯配置扩展，G2 激活现成组件）。
- **G6 依赖** map-system-design.md 提案 7 的 region 元数据（有降级路径）。
- 建议切片顺序（每片独立可玩 + 测试同步）：**G2 → G4/G5 → G1 → G3 → G7 → G6 → G8**。

## 五、共同约定（玩法版）

- **铁律不变**：以上全部按通用机制进 `framework/`（投射物/状态效果/技能/缩放/流程），游戏名词（武器名/技能名/Boss 名）只出现在 `game/` 配置与 `src/register.ts` 注册参数。
- **通用的接口、最小的实现**：每条提案的"第一步"都是最小集；demo 的全参数表是扩展目录，不是首期范围。
- **服务端权威 + 确定性**：所有随机走框架 deriveStream（demo 战斗用 `Math.random` 是反面教材，不学）；客户端只发意图，表现（特效/音效）由客户端按事件自行渲染。
- **数值单位对齐框架现状**（ms、格、像素）；demo 的帧单位（60FPS 假定）换算后再引用。
- 每项配 vitest 单测（`framework/__tests__/`）；配置改动后 `pnpm tools validate`。
