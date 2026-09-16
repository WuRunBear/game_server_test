# 玩法系统实现记录（借鉴 demo-e7ae1909）

> 状态标注：本文档已与实现同步（提交 0675aa2），后续以代码为准。
> 原为「G1–G8 玩法能力提案」；其中六个通用子系统与投射物最小集已落地（见第三节），
> 其余条目保留为后续配方切片（见第四节落地对照）。

## 一、背景与来源

来源：对纯前端地牢 roguelike `demo-e7ae1909`（元气骑士风格，Canvas 2D，位于 `/mnt/jixie/data/AI/project/game/demo-e7ae1909`）的只读源码调研——架构与地牢生成、玩法机制清点、本框架覆盖面 grep 核对各一份。本文档记录调研中确认**本框架缺失、且 demo 有成熟参照**的玩法层能力，作为后续切片的候选池。

与 `map-system-design.md` 的分工：地图生成相关（slot-rooms 槽位房间布局积木）已写入该文档；本文档只收录玩法/战斗/AI 层。双方唯一交叉点是房间流程（G6），它依赖 slot-rooms 产出的 region 元数据。

## 二、现状基线（改动前，历史记录）

| 能力 | 框架现状 | 证据 |
|------|---------|------|
| 攻击 | 瞬发 hitscan，`combatSystem.attackTarget`，伤害公式 max(1, 攻-防) | 无投射物 |
| 状态效果 | `Duration` 组件已注册但**零消费者**；无 buff/poison/burn/slow/stun 概念 | — |
| 技能/闪避 | PlayerCommand 8 种，PlayerInput 仅 move/interact/attack/talk；`Cooldown` 仅战斗使用 | 无 skill/dodge/ability |
| 武器模型 | `Attack` 组件仅 value/range；ItemKind 的 equip 仅 attackBonus/defenseBonus/gatherMult | 无 category/rarity/攻击模式 |
| 精英/缩放 | EntityRule 无任何缩放概念 | — |
| 房间流程 | 地图常驻全图模拟，演化引擎只做上限补足，无进入触发/清场判定 | — |
| 货币/商店 | 完全没有 | — |
| Boss 能力 | BT 仅 6 动作 4 条件 | 无 telegraph/范围弹幕/召唤/阶段节点 |

另有三个「已注册但未接线」的陷阱，借鉴时不要误判为已实现：`Duration`（**至今仍零消费者**——定时能力走新增的 ExpiresAt/Interval，见 3.3）、`AIState/Target/BlackboardRef`（全仓库无读写）、`Perception.hostilityRange`（组件注释自认占位）。

## 三、已实现：六个通用子系统 + 投射物最小集

实现形态与 map 侧一致：全部为**通用机制**（无游戏名词），注册表模式对齐 action/ruleModule；bootstrap 一次性装配；全部经 `framework/index.ts` barrel 导出；三个新测试文件 49 用例锚定。

### 3.1 事件总线（`framework/simulation/events/eventBus.ts`）

- 与 `framework/events/gameEvents.ts`（帧内轻量、无订阅者）互补：**类型化事件队列**，tick 内排队、固定阶段消费（不自动派发，保系统拓扑确定性）。
- API：`queueEvent(world, name, payload)` / `subscribeEvent` / `drainEvents`（清空式，triggerSystem 用）/ `dispatchEvents`（订阅式）。
- 事件表 `TypedEventPayloads`（interface merging 可扩展）：`on-timer`/`on-command`/`on-contact` 已由产生方接线；`on-hit`/`on-death`/`on-region-enter`/`on-region-clear` 预留（产生方留配方切片）。
- 帧首由 GameInstance.step 清空队列，事件只在产生它的那一 tick 有效。
- 挂在 `world.eventBus`（per-world 实例）。

### 3.2 效果系统（`framework/simulation/effects/`）

- 注册表 `effectRegistry.ts`：「效果名 → 执行器」工厂表，签名 `(ctx) => boolean`；`EffectSpec = { name, params? }` 声明式引用。未注册的效果名记 warn 跳过（不崩 tick）。
- 内置七效果（`builtinEffects.ts`，bootstrap 注册）：

| 效果名 | 语义 |
|--------|------|
| `damage` | 对目标扣血：走 `computeStandardDamage` 同一公式（含防御 + 装备加成），致命发 gameEvents `killed` 事件 |
| `heal` | 治疗（上限 Health.max） |
| `spawn-projectile` | 从作用位置发射直线投射物（vx/vy/lifeMs/radius） |
| `apply-status` | 给目标追加一条属性修饰符（状态的最小实现，见 3.4） |
| `impulse` | 瞬时位移脉冲（dx/dy） |
| `ledger` | 对目标账本 credit/debit（见 3.6） |
| `spawn-entity` | 按原型名召唤实体（count/offset/mapId） |

- 消费方：timerSystem 到期触发、triggerSystem 命中求值、命令通道——统一入口 `applyEffectSpecs`。

### 3.3 定时器（`framework/simulation/timer/`）

- AoS 组件（条目携带效果引用，SoA 表达不了）：`ExpiresAt`（一次性，绝对到期 tick）、`Interval`（周期 + 下次触发 + 剩余次数，负值无限）。
- `timerSystem`：到期/到周期 → `applyEffectSpecs` → 发 `on-timer` 事件 → 清理；落后追帧单 tick 最多补 64 次防病态循环。
- API：`setExpiresAt` / `setIntervalTimer` / `clearTimers`。
- **瞬态**：worldSerializer 跳过清单，恢复后由效果/触发配置重建。
- 注：`Duration` 组件仍零消费者（保留原组件不动，新定时能力独立实现）。

### 3.4 修饰符（`framework/simulation/modifiers/modifiers.ts`）

- `Modifiers` AoS：`statKey → ModifierEntry[]`（mul/add/bool 三型 + source + expiresTick）。
- `computeStat(world, eid, statKey, base)`：`base × (1+Σmul) + Σadd`；bool 型条目取或（布尔语义 stat 优先）。
- 过期条目惰性判定（读取路径过滤），不做主动清理。
- 现有移动/战斗系统**暂未接入** computeStat（接线留配方切片）；当前消费方为 `apply-status` 效果与测试。

### 3.5 触发器（`framework/simulation/triggers/`）

- `Triggers` AoS：`TriggerEntry = { trigger, effects[] }`，声明式挂载（`addTrigger`）。
- `triggerRegistry`：7 个内建求值器（`on-timer`/`on-command`/`on-hit`/`on-contact`/`on-death`/`on-region-enter`/`on-region-clear`），统一「实体事件」实现：owner=载荷 eid、target=载荷 target（缺省 owner），效果列表经 effectRegistry 求值。
- `triggerSystem`：固定阶段 `drainEvents` 消费事件总线 → 按事件名匹配 → 执行命中实体的效果列表。系统序 `after: ["timer"]`（同 tick 定时器事件可被消费）。

### 3.6 容器层（`framework/economy/container.ts` + `components/ledger.ts`）

- 统一容器接口 `queryContainer` / `insertContainer` / `removeContainer`，两种实现：
  - `"inventory"`：包装现有 InventoryEntry，insert 复用 `inventoryOps.addToInventory` 堆叠合并（maxStack 语义），remove 跨槽扣减；
  - `"ledger"`：新 `Ledger` AoS 组件（kind → 数量，无容量上限，归零移除键），insert 直加、remove 余额校验。
- 转移原语 `transferContainer` / `swapContainers`：**先全量校验后执行、失败整体回滚**（容器快照为回滚依据）；`snapshotContainer`/`restoreContainer` 供 settle 复用。
- Ledger 随实体入档持久化；aosSyncAdapters 新增 Ledger 适配器（`Ledger.<kind>` 展平，fields 白名单 `"entries"`）；archetype 可配初始条目。

### 3.7 交易（`framework/economy/settle.ts` + `offer.ts`）

- **L0 `settle(world, terms)`**：多方原子条款。`SettleTerms = SettlePartyTerms[]`，每方 `{ party, give?, take? }`（give/take 为 `{ container, kind, count }`）。流程：快照全部涉及容器 → 校验全部 give 足额 → 执行 give → 执行 take（剩余即容量不足）→ 任一失败整体回滚。支持任意方数，不做资产硬锁（同 tick 内先验后结）。
- **L1 报价会话**：`openOffer`（无 Player 标签的方即时确认，confirmedParties 视为已确认，全确认即结算）/ `acceptOffer` / `cancelOffer` / `pruneExpiredOffers` / `getOffer`。会话挂 `world.offerSessions`（运行时状态不入档，重启即作废，与无锁语义一致）。
- **命令接线**：PlayerCommand 新增 `offer` / `offer-accept` / `offer-cancel`（含 `offer` 条款、`offerId`、`ttlTicks`）；GameSimulation `submitCommand` 分发，发起方本人视为已确认；GameRoom.isPlayerCommand 浅校验（条款内容合法性由仿真层服务端权威校验）。命令成功时缓存 `on-command` 事件，下 tick beforeSystems 冲刷入总线供触发器消费。
- 覆盖全部参与方组合：玩家↔玩家（双方确认）、NPC/系统↔玩家（非玩家方即时确认）、NPC↔NPC（创建即结算）、多方链式交换。

### 3.8 投射物最小集 + 伤害公式抽取

- `Projectile` SoA 组件（`components/projectile.ts`）：owner/vx/vy/lifeMs/radius。
- `projectileSystem`（`systems/gameplay/projectileSystem.ts`）：tick 位移 → 目标格不可走（`walkableAt`，与 collisionSystem 同源）销毁 → 同图实体距离接触 → 发 `on-contact` 事件并销毁 → 寿命归零销毁。**命中只发事件，不接伤害闭环**（on-contact → damage 留配方切片）。系统序 `after: ["movement"]`。
- `spawnProjectile` 生成原语：无 archetype 的框架通用实体（归属随主人地图，kind 通用名 `"projectile"`），瞬态不入档。
- `computeStandardDamage(base, defense)` 纯函数（`systems/gameplay/damageFormula.ts`）：从 combatSystem.attackTarget 抽取共用，hitscan 与 damage 效果走同一数值路径（custom 公式 RuleModule 逻辑保留在 combatSystem 内）。

### 3.9 接线汇总

| 改动 | 位置 |
|------|------|
| 效果/触发器装配 | `framework/bootstrap.ts`（registerBuiltinEffects + registerBuiltinTriggers） |
| 事件总线/报价会话挂载 | `framework/world.ts`（eventBus/offerSessions/nextOfferId） |
| 帧首清空事件总线 | `framework/bootstrap/GameInstance.ts` |
| 新组件注册 | `framework/components/registerBuiltin.ts`（Ledger/Projectile/Modifiers/Triggers/ExpiresAt/Interval + Ledger AoS initializer） |
| 新系统注册 | `framework/systems/registerBuiltinSystems.ts`（projectile after movement；timer after quest；trigger after timer） |
| 瞬态清单 | `framework/persistence/worldSerializer.ts`（+ExpiresAt/Interval/Projectile） |
| 同步适配 | `framework/simulation/aosSyncAdapters.ts`（Ledger） |
| 命令与事件 | `framework/simulation/GameSimulation.ts` + `framework/simulation/types.ts` + `framework/net/colyseus/rooms/GameRoom.ts` |
| barrel 导出 | `framework/index.ts` |

## 四、G1–G8 落地情况对照

| 提案 | 状态 | 说明 |
|------|------|------|
| G1 投射物 | **部分** | 组件/系统/生成原语/on-contact 事件已落地；**PlayerInput 瞄准方向未动**（协议零改动，客户端 schema 副本无需同步）；on-contact → damage 伤害闭环未接 |
| G2 状态效果 | **部分** | 以 `apply-status` 效果 + Modifiers + timerSystem 实现通用地基（减速/DoT/眩晕均可用配置表达）；现有移动/战斗系统**未接入 computeStat** |
| G3 技能/闪避 | **未做** | 无 skill/dodge 命令、无 Invulnerable、无资源组件 |
| G4 武器配置 | **未做** | ItemKindSchema 无 attack 字段（equip 仍为 attackBonus/defenseBonus/gatherMult） |
| G5 精英缩放 | **未做** | EntityRule 无 scale/elite |
| G6 房间流程 | **未做** | on-region-enter/clear 事件类型已预留，产生方未接线 |
| G7 货币商店 | **地基** | ledger 效果 + settle 已构成经济地基；对话 buy/sell 效果、货币拾取入账未接 |
| G8 Boss 行为 | **未做** | 无 windup/shootRadial/summon/hpBelow |

## 五、实现与原设计的偏离

1. **协议零改动**：原 G1 方案要求扩展 PlayerInput 瞄准方向——本阶段未动 PlayerInput（客户端 schema 副本无需同步）；命令新增走 PlayerCommand 消息（GameRoom 浅校验，非 schema 字段）。
2. **伤害闭环后置**：投射物命中只发 on-contact 事件（配 on-contact 触发器即可闭环），不在系统内直接扣血——保持「事件驱动、配方组装」的一致性。
3. **computeStat 未接入现有系统**：避免在无真实玩法需求时改动 movement/combat 的取值路径（接线留配方切片，`apply-status` 效果已可写修饰符）。
4. **Duration 未激活**：新定时能力走 ExpiresAt/Interval，保留 Duration 原组件不动（其消费者仍为零）。
5. **无资产硬锁**：offer 会话先验后结、重启即作废（会话表不入档）——与「服务端权威 + 确定性」一致，避免锁标志侵入所有容器操作。

## 六、剩余切片顺序

已落地地基之上，配方切片按依赖推进：

1. **G1 收尾**：PlayerInput 加瞄准方向（唯一协议改动，客户端 schema 副本同步）+ on-contact 触发器 → damage 闭环 + 射速（Cooldown）
2. **G4/G5**（纯配置扩展，成本低）：ItemKindSchema equip 扩展 attack/category/rarity；EntityRule scale/elite
3. **G3**：skill/dodge 命令 + Invulnerable + 资源组件（依赖 1 的效果列表）
4. **G7**：对话 buy/sell 效果（settle 即时确认即商店）+ 货币拾取入账（ledger）
5. **G6**：on-region-enter/clear 产生方接线（依赖 slot-rooms region 元数据）+ 门格封锁 + 清场奖励
6. **G8**：BT 新动作/条件（windup/shootRadial/summon/hpBelow），依赖 1 与 5

## 七、共同约定（玩法版）

- **铁律不变**：以上全部按通用机制进 `framework/`（投射物/状态效果/技能/缩放/流程），游戏名词只出现在 `game/` 配置与 `src/register.ts` 注册参数。
- **通用的接口、最小的实现**：每个新能力的首期都是最小集；demo 的全参数表是扩展目录，不是首期范围。
- **服务端权威 + 确定性**：所有随机走框架 deriveStream（demo 战斗用 `Math.random` 是反面教材，不学）；客户端只发意图，表现由客户端按事件自行渲染。
- **数值单位对齐框架现状**（ms、格、像素）；demo 的帧单位（60FPS 假定）换算后再引用。
- 每项配 vitest 单测（`framework/__tests__/`）；配置改动后 `pnpm tools validate`。
