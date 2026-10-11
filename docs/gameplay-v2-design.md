# 玩法系统 v2 设计文档（荒岛求生）

> 状态：讨论定稿（未实施）。本文是 2026-10 玩法侧设计讨论的结论汇总，与
> `docs/map-system-v2-design.md`（地图侧）配套，共同构成荒岛求生升级的设计基线。
> 依据：① 荒岛求生系统调研（Don't Starve / Valheim / Project Zomboid / Green Hell /
> Raft / Subnautica 等系统拆解）；② 框架玩法能力源码审计（21 系统/组件/配置全量核对）。
> 切片落地前以现行源码为准。

## 0. 一句话总纲

**框架不缺地基缺接线：先激活休眠层（状态效果/投射物/触发器/定时器/经济），再按八大类补通用机制，所有游戏语义走 game/*.json 配置，src/register.ts 目标保持为空。**

## 1. 审计结论（现状）

### 1.1 核心发现：玩法配方层整体休眠

G1–G8 期间建的玩法地基**已建成但未通电**：

- `projectile` / `timer` / `trigger` 三系统已注册，但 **game.json 的 systems 未启用** →
  投射物、定时效果、事件驱动玩法当前完全不可用。
- `Modifiers.computeStat` 存在，但 **combat / movement 不读它** → 即便施加减速/DoT
  修饰符也无实际效果（框架注释自认"接线留配方切片"）。
- `Triggers` / `ExpiresAt` / `Interval` / `Ledger` 组件 game 侧零使用。
- economy 模块（offer/settle/容器）完整，`PlayerCommand.offer` 已通，但无货币物品、
  无买卖配置。

**结论：玩法升级第一刀不是造新机制，是把已建的接通。**

### 1.2 已达标（直接可用或纯配置补）

生存属性衰减 + 归零 DoT（Needs 任意命名，thirst 已验证）、采集再生循环、装备加成、
配方合成 + 制作站距离校验、网格建造 + 所有权 + 拆除、对话树 + 任务 + 好感、袭击波
（raid 规则 + waveRef）、掉落表、服务端权威联机全套（输入校验/兴趣裁剪/per-client
同步/断线以最近存档为准）。

### 1.3 铁律审计

framework/ 逐词扫描零游戏名词命中；src/register.ts 为空占位。分层纪律保持干净，
本设计的总体目标依然是 **src 零内容**——连"篝火取暖""食物中毒"拆开都是
"状态效果 + 条件"的配置组合。

## 2. 八大缺口大类

### 2.1 生存压力类（survival）

现状：仅 hunger/thirst 衰减 + 归零扣血。

| 缺口 | 方案 | 层 |
|---|---|---|
| 环境调制需求 | 温度/天气/季节影响衰减速率（冷季耗食快、暴雨加速口渴）——WorldClock 相位作乘子 | framework（与地图 v2 切片 1 共享时钟） |
| 睡眠/休息 | Sleep 行为已有、无恢复逻辑；补"睡眠恢复 + 夜晚野外风险"取舍 | framework 通用机制 + game 配置 |
| 体力 | 新 Needs 字段（奔跑/战斗消耗），衰减框架现成 | game 配置为主 |
| 状态 DoT 闭环 | computeStat 接进 combat/movement（框架自有 TODO） | framework 接线 |
| 疾病 | 生食/污水按概率触发状态效果（中毒/感染） | game 配置（吃状态效果闭环） |

### 2.2 资源与生产类（economy-production）

现状：采集即得、节点固定单产物、合成即时。

| 缺口 | 方案 | 层 |
|---|---|---|
| 工具门槛 | harvest 加 requiredToolTag（通用采集条件） | framework |
| 采集掉落表化 | 资源节点复用 LootTable 语义（一树多产物 + 概率） | framework（复用现有语义） |
| 物品耐久 | ItemMeta 加 durability 通用字段 + 磨损消耗点 | framework |
| 食物腐烂 | ItemMeta 加 spoilAt + 延长加工（晒肉架/熏制） | framework 字段 + game 内容 |
| 制作时间与燃料 | craft duration ticks + 站点燃料消耗（fuelRemainingMs 字段已存在无消费者） | framework |
| 多层加工链 | 原木→木板→家具（配方图已支持，缺内容纵深） | game 配置 |

### 2.3 成长与进度类（progression）

现状：成长=装备数值，配方全局可用，无长期目标。

| 缺口 | 方案 | 层 |
|---|---|---|
| 配方解锁/科技树 | 挂 condition 注册表（与 isNight 同模式）；与季节材料循环绑定——DS 式"灾害产出解药"跨季准备 | framework 机制 + game 配置 |
| 经验/技能等级 | 可选档（PZ 式使用熟练度） | 后置 |
| 世界进度状态 | 击败 Boss 解锁新区域/配方/事件，进 WorldRecord 全服共享 | framework |
| 成就/挑战 | 后置 | 后置 |

### 2.4 威胁与战斗类（combat-threat）

现状：近战 + 直线追击 + 固定袭击波，威胁可预测。

| 缺口 | 方案 | 层 |
|---|---|---|
| 寻路 | A*（walkable 网格现成；**必须按地图 v2 的 level 维度预留**） | framework |
| Boss/精英与阶段行为 | BT 阶段节点 + 世界唯一实体 | framework 节点 + game 内容 |
| 袭击导演补全 | 预警期/进度门槛/无玩家暂停（Valheim 语义） | framework |
| 远程与弹道 | 投掷矛 demo（projectile 系统激活 + PlayerInput 瞄准方向） | framework 接线 + game 配置 |
| 击退与控制 | impulse 效果接战斗 | framework 接线 |
| 武器分化 | 暴击/攻速/克制 | 后置 |

### 2.5 经济与交易类（economy-trade）

现状：economy 模块完整但 game 零配置，无货币。

| 缺口 | 方案 | 层 |
|---|---|---|
| 货币物品 | 贝壳等一般等价物 | game 配置 |
| 商店与买卖 | 对话效果接 buy/sell（villager 交易站） | framework 效果 + game 配置 |
| 物品稀有度/分类 | value 标签（交易与掉落的定价基础） | framework 字段 + game 内容 |
| 价格波动 | 供需/季节调制 | 后置 |

### 2.6 建造与基地类（base-building）

现状：网格放置 + 所有权 + 拆除（不返还材料）。

| 缺口 | 方案 | 层 |
|---|---|---|
| 多层叠放 | 地板承托墙——**已归地图 v2 切片 6**（(x,y,level) 占位） | 地图 v2 |
| 可交互结构 | 门开关/家具使用 | framework |
| 结构防御值 | 袭击目标物、可被打坏（与袭击导演互为对手盘，建议同切片） | framework |
| 拆除返还 | 部分材料返还 | framework |
| 容器存储 | 箱子（Ledger 组件已存在未启用） | framework 接线 + game 配置 |
| 基地功能性 | 床设重生点/储物/晾肉架 | game 配置 |

### 2.7 社交与叙事类（social-narrative）

现状：对话树 + 任务 + 好感已通，但好感零消费。

| 缺口 | 方案 | 层 |
|---|---|---|
| 好感消费 | 按好感解锁对话/任务/交易折扣（Relation 可存可读无消费方） | framework 条件 + game 配置 |
| 任务前置与链式 | QUEST_AVAILABLE 常量存在未用 | framework |
| 声望/势力 | S7 已记录后置 | 后置 |
| 商店 NPC | 与 2.5 交叉 | 同 2.5 |

### 2.8 死亡与进度风险类（death-penalty）

现状：死亡仅传送重生（不掉背包/无尸体），removePlayer 即销毁实体（闪断丢
≤60s 进度）——生存负反馈缺失。

| 缺口 | 方案 | 层 |
|---|---|---|
| 死亡策略配置化 | 尸体实体 + 背包掉落可拾回（DS 式）/ 倒地救援（Raft 式），档位走 rules | framework（都是已有原语组合） |
| 断线实体保留 | 保留时长配置化（防闪断） | framework |
| 永久死亡选项 | 硬核模式档位 | game 配置 |

## 3. 框架 vs src 分层判定（第 5 步结论）

- **纯 game/*.json**（框架能力现成）：启用三系统、货币物品、体温/睡眠/体力新
  Needs 字段、精英怪 archetype、疾病触发、全部内容纵深（配方/对话/任务/物品）。
- **framework 补通用机制**（全部游戏无关）：computeStat 接线、durability/spoilAt/
  value 通用字段、requiredToolTag、资源节点掉落表、配方解锁条件、craft duration、
  燃料消耗、A* 寻路（level 预留）、BT 阶段节点、袭击导演语义、死亡策略原语、
  断线保留选项、门交互、结构防御值、拆除返还、好感条件。
- **src/**：维持空。目标是整个升级完成时 src/register.ts 仍为零内容——这是对
  "通用接口、最小实现起步、能力随真实需求生长"原则的验收标准。

## 4. 玩法切片（与地图 v2 九切片交错）

| # | 切片 | 内容 | 依赖 |
|---|---|---|---|
| A | 激活休眠层 | 启用 projectile/timer/trigger + computeStat 接 combat/movement + 状态效果闭环 + 投掷矛 demo | 无（可立即动工，与地图切片 1 并行） |
| B | 生存深度 | 工具门槛、采集掉落表、耐久、死亡策略、断线保留 | A |
| C | 科技树与制作 | 配方解锁条件、制作时间、站点燃料、多层加工链 | A；与地图切片 1（WorldClock）联动后做季节绑定 |
| D | 威胁升级 | A* 寻路、Boss 阶段、袭击导演补全、结构防御值 | A；寻路注意地图切片 4 的 level 维度 |
| E | 经济商店 | 货币、买卖效果、好感折扣（吃 2.7 好感消费） | A、C（稀有度 value） |
| — | 腐烂/农业 | 吃地图切片 2（FSM）现成状态机 | 地图 v2 切片 2 |
| — | 多层建造 | 地图 v2 切片 6 | 地图 v2 |

每切片照旧三同步：可玩 demo + 框架增长通用机制 + 测试/文档同步。

## 5. 悬置决策（动工前需定）

1. **死亡惩罚档位**：DS 式掉全部背包（硬核） / Raft 式倒地救援（联机友好） /
   可配置默认软档。建议：可配置，默认"尸体 + 背包可拾回"。
2. **断线保留时长**：保留到下一存档周期 vs 保留 N 分钟防闪断。建议：N 分钟
   配置化（默认 5 分钟），到期销毁走 death 无尸分支。
3. **经验/技能等级**是否进本版本（建议否，P2）。

## 6. 不做 / 后置

- 价格波动、声望/势力、成就、暴击/克制分化（P2 内容层）。
- 网格拖拽背包 UI（维持线性槽，铁律"不造格子拖拽引擎"）。
- LagComp / 客户端预测回滚（ROADMAP 缺口，联机深度单独评估）。
- 玩家属性数值成长（经验等级）——装备与科技已承载成长曲线。

## 附：审计依据摘要

- 休眠证据：`framework/systems/registerBuiltinSystems.ts`（21 注册）vs
  `game/game.json` systems（18 启用，缺 projectile/timer/trigger）；
  `framework/systems/gameplay/modifiers.ts` 注释自认 computeStat 未接线。
- 能力矩阵详情：见 2026-10 玩法审计报告（本会话）；地图层见
  `docs/map-system-v2-design.md` §9 前置修正清单与附录。
- 调研锚点：DS Regrowth 四机制 / hound wave 预警-间隔-峰值曲线 / Valheim
  事件 46min20%/3 建筑门槛/无玩家暂停 / PZ moodle 分层 / Raft 倒地救援；
  生态结论"无主流游戏跑真食物链"（详见地图 v2 文档 §6）。
