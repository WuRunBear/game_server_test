# 服务端对接协议（客户端接入指南）

> 本文档是**独立协议契约**：任何 Colyseus 客户端项目（无论语言/引擎）仅凭本文档即可对接本服务端，
> **无需访问服务端源码**。文档中的消息格式、状态结构、字段语义以文档为准；若部署方明确告知协议有变更，以部署方为准。
>
> **机制 vs 配置产物**：本文规范的是协议**机制与形状**（Schema 字段/顺序、消息名与载荷形状、端点契约、校验与错误语义、特征辨识方法、命令白名单）；文中出现的具体数值/内容清单是当前部署游戏配置的**产物**（以「荒岛求生」配置为例标注），会随 `game/` 配置漂移，各节均标注其配置来源（`game/rules/*.json`、`game/items/`、`game/entities/`、`game/maps/registry.json`、`game.json`），客户端不应硬编码。
>
> 技术基线：Colyseus 0.17 + @colyseus/schema 4.x（二进制增量同步，WebSocket 传输）。

---

## 1. 连接

### 1.1 服务端地址

服务端地址由**部署方提供**，通常形如 `ws://<host>:<port>` 或 `wss://<host>`。建议客户端将地址做成可配置项（如环境变量），不要硬编码。

```ts
import { Client } from "colyseus.js";

const endpoint = "ws://localhost:3000"; // ← 部署方提供
const client = new Client(endpoint);
const room = await client.joinOrCreate<RoomState>("game");
```

### 1.2 房间模型

- 房间类型名：**`game`**（`joinOrCreate("game")`）。
- **单房间常驻**：服务端启动时即创建唯一房间，客户端退出不销毁；新客户端随时可加入同一世界（世界共享、存档持久）。
- 每个连接 = 一个玩家实体，sessionId 由服务端分配（`room.sessionId` 即自己的 sessionId）。
- 房间无鉴权/密码。

### 1.3 重连语义

- 服务端定时持久化（周期由 server 规则 `saveIntervalMs` 配置，见 `game/rules/server.json`）。重启后世界从存档恢复。
- **断线即销毁玩家实体**（不是保留）：重连进房间 = 按出生规则**新建**实体落点，进度以**最近一次存档**为准（存档周期内的最后一段进度会丢，见 §7）。
- NetworkId 仅在**服务端重启后读档恢复**的场景复用：恢复出的玩家实体由加入流程复用绑定（NetworkId 保留存档值）；正常运行期间的断线重连产生**新实体、新 NetworkId**。

---

## 2. 上行协议（客户端 → 服务端）

两条消息通道，均为 JSON 序列化对象。

### 2.1 逐帧输入 — 消息名 `"input"`

```jsonc
{
  "seq": 1,          // 自增序号（必填）。乱序/重复/小于等于上一条的被丢弃
  "moveX": 0,        // 水平速度分量，像素/秒（必填）
  "moveY": 20,       // 垂直速度分量，像素/秒（必填；幅度示例，上限见下表）
  "interact": false, // 可选：本帧按下"采集"键
  "attack": false,   // 可选：本帧按下"攻击"键
  "talk": false      // 可选：本帧按下"对话"键
}
```

约束：

| 项 | 值 |
|----|----|
| `seq` | 严格递增正整数；被拒输入不推进 seq、无需重发（下一条更高 seq 输入照常放行） |
| 速度上限 | `\|(moveX, moveY)\|` 受 server 规则速度上限限定（像素/秒），超出整条输入被拒。配置源 `game/rules/server.json` 以格/秒表达（`maxMoveSpeedTiles`，加载期按 `game.json` `world.tile` 换算为像素/秒；当前 2 格/s = 32 px/s） |
| 意图信号 | `interact` / `attack` / `talk` 为边沿触发（按下那帧置 true 即可，服务端消费后清除） |
| 权威模型 | 服务端权威：客户端**不要**自行预测位移，以状态同步为准 |

### 2.2 离散命令 — 消息名 `"command"`

```jsonc
{ "type": "craft", "recipe": "<recipeId>" }
```

命令类型与参数：

| type | 参数 | 语义 |
|------|------|------|
| `consume` | `slot: number` | 食用背包 `slot` 槽物品（恢复生存需求） |
| `drop` | `slot: number` | 丢弃背包 `slot` 槽物品（生成地面掉落物实体） |
| `transfer` | `slot: number`, `toSlot: number` | 背包槽间移动/堆叠 |
| `craft` | `recipe: string` | 合成（`recipe` 引用 crafting 配置定义的配方 id，见 §4.4） |
| `equip` | `slot: number` | 穿戴背包 `slot` 槽物品 |
| `place` | `slot: number`, `x: number`, `y: number` | 放置 kit 物品 → 生成建筑实体（世界坐标） |
| `deconstruct` | `target: number` | 拆除自己放置的建筑（target = 实体 NetworkId） |
| `dialogue` | `option: number` | 推进当前对话（选项索引，见 §4.6） |
| `offer` | `offer: TradeParty[]`, `ttlTicks?: number` | 发起交易：提交各方条款，发起方本人视为已确认 |
| `offer-accept` | `offerId: number` | 确认目标报价（全部参与方确认后成交） |
| `offer-cancel` | `offerId: number` | 取消目标报价 |

`offer` 的 `offer` 参数是交易条款数组（`TradeParty[]`），每项形如：

```jsonc
{ "party": 3, "give": [{ "container": "inventory", "kind": "<itemKind>", "count": 5 }], "take": [{ "container": "inventory", "kind": "<itemKind>", "count": 2 }] }
```

- `party` = 参与方实体 eid；`give` = 该方给出的数量列表（成交时从其容器扣减），`take` = 该方收取的数量列表（成交时插入其容器）；`container` ∈ `inventory` | `ledger`。
- 可选 `ttlTicks` 为报价有效期（tick 数，缺省不过期）；发起方本人视为已确认，`offer-accept` 由对方确认，全部参与方确认后成交。
- 交易账本（ledger）状态**不进入状态同步**（§3.5 无对应 key）——交易由服务端权威推进，客户端以 `Inventory` 变化确认成交结果。

约束：

| 项 | 值 |
|----|----|
| 频率上限 | 由 server 规则 `maxCommandsPerSec`（`game/rules/server.json`）限定（滑动窗口），超出被拒 |
| 失败语义 | 任何命令失败（缺料/满包/距离不够/无权拆除等）**无错误回执**，服务端零副作用；客户端以状态变化为准 |
| 命令不进入 `seq` 去重 | 重复发送会被多次执行，客户端自行防抖 |

---

## 3. 下行协议（状态同步）

Colyseus Schema 增量同步（补丁 + 全量握手）。**客户端必须声明与服务端一致的状态结构**，§3.4 给出完整可复制定义。

### 3.1 RoomState（房间根状态）

| 字段 | 类型 | 说明 |
|------|------|------|
| `tick` | uint32 | 逻辑帧号（tick 率由 game.json `tickRate` 配置；当前示例 20 帧/秒 = 50ms/帧） |
| `hour` | float64 | 世界小时 0–24（昼夜循环推进） |
| `phase` | uint8 | 0=白天，1=夜晚 |
| `players` | map\<string, PlayerState\> | key = sessionId |

> **房间级状态只有上面四个字段**（协议破坏性变更）：`RoomState` 不再携带 `mapId` / `entities`。玩家的当前地图是 **per-player** 的，经 `PlayerState.mapId` 同步（见 §3.2），**不是**房间级字段；实体同步恒走 per-client 的 `PlayerState.visibleEntities`（见 §3.2），`RoomState` 内没有实体表。

### 3.2 PlayerState（每玩家）

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | string | 本连接 sessionId（等于 `room.sessionId`） |
| `entityId` | uint32 | 自己控制的实体 NetworkId（`players.get(room.sessionId).entityId`） |
| `mapId` | string | 该玩家**当前所在地图 id**（per-player）：仅当**该玩家自己**走进传送门触发换图时变化，其他玩家不受影响 |
| `visibleEntities` | map\<string, EntityState\> | 本玩家可见实体表（**唯一的实体来源**）：key = NetworkId 字符串，只含本玩家可见实体 |

**兴趣裁剪（重要）**：实体同步**恒**走每个玩家自己的 `visibleEntities`——自 per-player 协议起，`RoomState` 的 `entities` 已移除，**不存在**房间级实体表或兼容通道：
- 自己（`entityId` 对应实体）恒在表中；其他实体进入半径（由 server 规则配置，见 `game/rules/server.json` 的 `viewRadiusTiles`——格，加载期换算为像素；未配置时同图全量）才出现，离开即被删除。
- 客户端只遍历 `state.players.get(room.sessionId).visibleEntities`，无需再读任何房间级实体表。
- 该表仅对自己可见（服务端按连接过滤，经 `$filter` per-client 编码），不要假设能看到其他玩家的表。
- 跨图实体被过滤：玩家只看到**同一地图**（`PlayerState.mapId`）内的实体 + 半径内；换图后旧图实体随即从此表移除。
- 这是**唯一**的实体交付路径（破坏性变更，旧客户端读取 `RoomState` 的 `entities` 会失败）。

### 3.3 EntityState（单实体）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uint32 | NetworkId（稳定标识，实体一生不变；同实体复用，重建不产生新 id） |
| `values` | map\<string, number\> | 数值字段，key = `"组件.字段"` |
| `stringValues` | map\<string, string\> | 字符串字段，key = `"组件.字段"` |

**字段 key 约定**：
- SoA 标量：`"Transform.x"`、`"Health.current"`、`"Collider.shape"`（0=圆形 1=矩形）
- AoS 展平：`"Needs.0.name"`、`"Inventory.3.kind"`、`"Quest.0.state"`、`"Dialogue.0.option"`
- 组件索引位置稳定；**空槽有占位值**（如 `"Inventory.3.kind"` = `""`），"key 存在"不代表"有货"
- 同步是增量 diff：字段消失时（如对话结束、需求槽缩短）key 会被删除，读取注意 `undefined`

### 3.4 客户端 Schema 定义（可直接复制）

> 字段**顺序**是线协议的一部分：客户端声明必须与服务端一致，否则状态解析错乱。
> 服务端升级协议（增删字段）后需同步更新客户端定义。

```ts
import { Schema, MapSchema, type } from "@colyseus/schema";

export class EntityState extends Schema {
  @type("uint32") id: number = 0;
  @type({ map: "number" }) values = new MapSchema<number>();
  @type({ map: "string" }) stringValues = new MapSchema<string>();
}

export class PlayerState extends Schema {
  @type("string") sessionId: string = "";
  @type("uint32") entityId: number = 0;
  @type("string") mapId: string = "";
  @type({ map: EntityState }) visibleEntities = new MapSchema<EntityState>();
}

export class RoomState extends Schema {
  @type("uint32") tick: number = 0;
  @type("float64") hour: number = 8;
  @type("uint8") phase: number = 0;
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}
```

> 协议破坏性变更：`RoomState` 已移除 `mapId` 与 `entities`（旧字段顺序对齐的客户端会错位解码）；`PlayerState` 新增 `mapId`。字段**顺序**是线协议的一部分——客户端声明必须与服务端一致（见 §3.4 顶部提示），旧客户端解码新流会错位、需升级。

（非 TS/JS 客户端：以本表字段名/类型/顺序为准，用各自语言的 @colyseus/schema 绑定声明。）

### 3.5 同步字段清单（客户端可依赖的 key）

> 同步键由 `game.json` 的 `netSync.fields` 配置决定，客户端应以实际快照为准；下表为当前配置的产物（荒岛求生示例）。字段 key 只会有这些；**实体按"拥有哪些组件"决定带哪些 key**（§3.6）。

| 组件 | key 形态 | 语义 |
|------|----------|------|
| Transform | `Transform.x`, `Transform.y` | 世界坐标（像素） |
| Health | `Health.current` | 当前血量（生物） |
| Collider | `Collider.shape`, `Collider.radius` | 碰撞形状：0=圆形 1=矩形 |
| Size | `Size.w`, `Size.h` | 尺寸 |
| Needs | `Needs.{i}.name/current/max` | 生存需求（条目集与 name 由 needs 规则定义，见 `game/rules/needs.json`；任一为 0 持续扣血） |
| Inventory | `Inventory.{i}.kind/count` | 背包槽（容量由玩家原型配置定义；空槽 kind=`""` 占位） |
| ItemMeta | `ItemMeta.kind/count` | 地面掉落物 |
| ResourceNode | `ResourceNode.remaining` | 资源点剩余量（0 后消失，可再生） |
| Equipment | `Equipment.weaponSlot/toolSlot/armorSlot` | 装备槽引用的**背包槽索引**（-1=空） |
| CraftingStation | `CraftingStation.stationType` | 合成站类型 id（类型语义由 crafting 配置定义；当前示例：0=通用，1=光源站点） |
| LightSource | `LightSource.radius/fuelRemainingMs` | 光源半径与剩余燃料（≤0 熄灭） |
| Placeable | `Placeable.footprintW/footprintH/canCollide` | 放置物占用/阻挡信息 |
| GridOccupancy | `GridOccupancy.cellX/cellY/cellW/cellH` | 建筑占用的网格 |
| Portal | `Portal.targetMap/x/y` | 传送门：目标地图与落点 |
| Dialogue | `Dialogue.npcId/treeId/nodeId/{i}.option` | 玩家对话会话（仅对话中出现的 key，见 §4.6） |
| DialogueSource | `DialogueSource.treeId` | NPC 挂载的对话树 id |
| Quest | `Quest.{i}.questId/state/count` | 玩家任务（state：0未接/1进行/2可交/3完成） |
| Relation | `Relation.{i}.npcKind/value` | 与 NPC 的好感值 |

### 3.6 实体辨识（客户端如何知道"这是什么"）

服务端**不发送**实体种类字段；客户端按同步字段组合辨识：

| 特征 | 判定 |
|------|------|
| `ResourceNode.remaining` | 资源点（可采集） |
| `ItemMeta.kind` | 地面物品（可拾取） |
| `DialogueSource.treeId` | NPC（可对话） |
| `Health.current`（无其他特征） | 敌怪（可攻击） |
| `Health.current` + `Needs.*` | 其他玩家 |
| `CraftingStation.stationType` + `LightSource.*` | 光源型合成站（带燃料与照亮半径的合成站点） |
| `Portal.targetMap` | 传送门 |
| `Placeable.*` | 建筑 |

---

## 4. 玩法机制（协议映射）

> 本节规范玩法对应的**协议机制**；具体数值/内容清单是游戏配置的产物，随 `game/` 配置漂移，客户端不应硬编码判定——「当前配置来源」列给出各类值的定义处。

| 玩法 | 操作 | 服务端反应 | 当前配置来源 |
|------|------|-----------|-------------|
| 移动 | `input` moveX/moveY | 速度积分 + 碰撞分离 → `Transform.x/y` 同步 | 速度上限 = server 规则（`game/rules/server.json` 的 `maxMoveSpeedTiles`，格/秒，加载期换算为像素/秒） |
| 采集 | `input` interact | 半径内最近资源实体 → `ResourceNode.remaining` 减少 → 物品入包/落地 | 交互半径 = `game.json` `systems[].config`（interaction 的 `range`） |
| 近战攻击 | `input` attack | 半径内最近敌对实体 → 目标 `Health.current` 减少；击杀按 LootTable 落地掉落物 | 攻击射程取实体 `Attack` 组件值，缺省回退 combat 规则（**组件值优先**）；冷却/无友伤/伤害公式见 `game/rules/combat.json` |
| 拾取 | 无操作（走近自动） | 地面物品消失 → `Inventory` 计数增加 | 自动拾取 + 防瞬回保护（落地后短暂不可拾，框架行为） |
| 对话 | `input` talk → `command dialogue` | 见 §4.6 | 对话半径 = dialogue 规则 `talkRange`（未配置用框架缺省）；talk 路由半径同 interaction 配置 |
| 合成 | `command craft` | 消耗材料 → 产出入包（缺料/满包/站点不符零副作用） | 配方集由 `game/rules/crafting.json` 定义（§4.4）；站点判定半径 = crafting 规则 `stationRange` |
| 装备 | `command equip` | `Equipment` 三槽更新，攻击/采集加成即时生效 | 槽位 weapon/tool/armor 是协议形状；加成数值由物品配置（`game/items/`）定义 |
| 食用/丢弃 | `command consume/drop` | 需求恢复 / 地面掉物 | 食用恢复量由物品配置（`game/items/`）定义 |
| 放置 | `command place` | 校验后消耗 1 个 kit → 生成建筑实体 | 放置距离/网格吸附由 place 规则（`game/rules/place.json`）配置 |
| 拆除 | `command deconstruct` | 仅放置者可拆、范围校验、不返还材料 | 范围同 place 规则 `placeRange` |
| 任务 | 对话选项触发 | 见 §4.7 | 任务定义见 `game/quests/`，经对话树（`game/dialogues/`）选项效果挂接 |
| 昼夜 | 被动 | `hour/phase` 每帧同步 | 夜晚区间/昼夜周期由 daynight 规则（`game/rules/daynight.json`）配置 |
| 场景切换 | 走近传送门 | 该玩家 `PlayerState.mapId` 变化、实体集切换（玩家自身保留；其他玩家不受影响） | 传送门实体由地图配置/演化规则产出（同步形状见 `Portal.targetMap/x/y`） |

### 4.1 背包与物品

- 背包槽位容量由玩家原型配置（`game/entities/` 下玩家实体的 `Inventory.capacity`）决定；`Inventory.{i}.kind` 空槽为 `""`。
- 物品 kind 集合由 `game/items/` 定义（每个 kind 一个文件：堆叠上限、食用效果、装备加成、是否可放置 kit 等全部随配置）；客户端**不应内置物品清单**，按 `Inventory.{i}.kind` / `ItemMeta.kind` 原样透传显示即可。
- 装备槽语义（weapon/tool/armor）是协议形状；各槽对攻击/采集的加成数值由物品配置定义。

### 4.2 生存需求

- 需求条目集与名称由 needs 规则配置（`game/rules/needs.json`）定义，经 `Needs.{i}.name` 同步；客户端按 `name` 渲染，**不假设条目数量与含义**。
- 任一需求降到 0 持续扣 `Health.current`；通过 `consume` 恢复（恢复量由物品配置定义）。

### 4.3 敌对实体

- 敌对实体的种类与分布由生态/演化配置产出（`game/ecosystems.json`、`game/maps/entity-rules.json`）；种类集随配置变化，客户端一律按 §3.6 特征辨识，**不内置敌怪清单**。
- 巢穴类实体：带 Nest 组件的生产者实体周期在巢周围补怪（补怪种类/容量/间隔由实体配置的 Nest 组件定义）。Nest 组件**不同步**——巢实体的同步特征只有 `Health`/`Size`（§3.6 会辨识为「敌怪」），实际是静止可击杀的结构；摧毁后停产。
- 周期袭击（raidSystem）：周期/波次规模/敌怪种类由 raid 规则（`game/rules/raid.json`）配置，在**玩家附近**刷出敌对波。
- 敌对实体 AI：感知（视野半径 = 实体 `Perception` 组件）→ 追击 → 近战攻击；对光源回避（光源站点附近相对安全）。
- 击杀掉落物经 LootTable 掷骰落地（`ItemMeta` 实体；掉落表由实体配置定义）。

### 4.4 合成配方（recipe id）

- `craft` 命令的 `recipe` 参数引用 crafting 配置（`game/rules/crafting.json`）的 `recipes[].id`；每条配方的消耗/产出/站点要求全部由该配置定义，**协议不枚举配方**。
- 客户端**不应内置配方清单**。如需展示配方列表：由宿主游戏注入配置，或等服务端后续提供配方查询端点；最小客户端做法是按配置文件静态生成或由开发者手动维护。
- 站点要求（`stationType`）语义由 crafting 配置定义（当前示例：0=通用/无站点要求，其他值对应具体站点类型）。

### 4.5 建造

- `place` 消耗 1 个 kit 类物品生成建筑实体（放置距离/网格吸附由 place 规则 `game/rules/place.json` 配置）。
- 建筑默认是静态阻挡（是否阻挡由实体配置的碰撞属性决定）；`deconstruct` 仅放置者可拆。
- 建筑实体带 `Placeable.*` / `GridOccupancy.*` key（占用网格由服务端吸附计算，客户端只读）。

### 4.6 对话

1. `input { talk: true }` → 半径内最近 NPC 开始对话。
2. 服务端同步 `Dialogue.*` key（`nodeId` + `{i}.option` 选项文本数组）。
3. 客户端渲染选项，选第 i 项 → `command { type: "dialogue", option: i }`。
4. 服务端执行选项效果（接/交任务、好感）；**效果失败停留在当前节点**（可重试）；`__end__` 选项结束对话（`Dialogue.*` key 消失）。
5. NPC 实体带 `DialogueSource.treeId`（树 id），用于区分不同 NPC 的对话。

### 4.7 任务

- 任务挂在玩家实体上：`Quest.{i}.questId/state/count`。
- 接取/提交都通过**对话选项效果**触发（不是独立命令）。
- 进度：collect 型随背包变化实时更新；kill 型击杀目标后更新；`state=2`（可交）时回到 NPC 对话选提交选项 → 消耗任务物品 + 发奖励 + 好感 + `state=3`（完成）。

---

## 5. 调试与辅助接口

### 5.1 碰撞体调试（WebSocket 消息）

```ts
room.send("debug_colliders_subscribe");   // 订阅：立即收到一次完整快照（含地图碰撞体），之后每 500ms 增量
room.onMessage("debug_colliders_snapshot", (snap) => { /* 渲染 */ });
room.send("debug_colliders_unsubscribe"); // 取消
room.send("debug_colliders_pull");        // 单次拉取（不订阅）
```

快照结构（JSON）：

```jsonc
{
  "tick": 1234,                                   // 逻辑帧号
  "mapBodies": [                                  // 仅首次/主动拉取时存在（含地图静态碰撞体）
    { "kind": "map", "shape": "box", "x": 0, "y": 0, "width": 800, "height": 600 }
  ],
  "entityBodies": [                               // 每帧实体碰撞体
    { "kind": "entity", "shape": "circle", "eid": 3, "x": 100, "y": 100, "r": 8 },
    { "kind": "entity", "shape": "box", "eid": 5, "x": 200, "y": 200, "width": 32, "height": 32 }
  ],
  "pairs": [ { "id": "3|5", "a": "3", "b": "5", "overlap": 4 } ]   // 本帧碰撞对（调试用）
}
```

> 订阅后每 500ms 推送一次；`mapBodies` 仅在首次订阅/换图/主动拉取时下发，之后为 `undefined`，客户端应缓存首次的地图碰撞体。

### 5.2 HTTP 端点（与 WebSocket 同主机/端口）

> **地图契约 v2（地图系统重设计后）**：`/maps/runtime` 不再返回 chunk 化阻挡位图，改为**全图几何快照**（`tiles`/`walkable`/`regions`/`regionOfTile` 纯 JSON 数组，一次拉取，无 base64）；响应标识字段 `id`→`key`；通行语义反转（`walkable`：1=可走，0=阻挡）。旧版按 `blocked` 位图/`chunks` 分块解码的客户端需升级。

| 端点 | 说明 |
|------|------|
| `GET /health` | 健康检查，`{"ok":true}` |
| `GET /maps/runtime?mapId=<key>` | 地图几何全图快照：网格尺寸、地面语义 `tiles`、通行位图 `walkable`、区域 `regions`/`regionOfTile`、内容版本。用于客户端加载地图/碰撞。`mapId` 可选：省略时返回默认地图（game.json `map.default`，即 `/maps/meta` 的 `default` 字段）；未知 key（含空串）返回 404，错误体附可用图列表 |
| `GET /maps/meta` | 地图清单：默认图 key 与全部地图的元信息（含 version）。客户端可先拉取清单列出地图、预检版本，再按需拉取 runtime |
| `GET /debug/colliders` | 房间碰撞体调试快照（房间未就绪时 404） |

`/maps/runtime` 返回示例（**以当前 game/ 配置「荒岛求生」为例**——地图清单/尺寸/区域名均为配置产物，随配置漂移）：

```jsonc
{
  "key": "island",
  "grid": { "width": 192, "height": 192, "tileWidth": 16, "tileHeight": 16 },
  "tiles": [1, 1, 1, …],          // 每格地面语义 id（number[]，行主序，长度 = width×height）；id→含义的映射在游戏配置，客户端自备 id→颜色/贴图色表渲染地面
  "walkable": [0, 0, 0, …],       // 每格通行位图（number[]，行主序）：1=可走，0=阻挡
  "regions": {                    // 区域名 → 区域元信息（普通对象；键顺序 = regionOfTile 的索引序）
    "beach": { "name": "beach", "meta": {} },
    "grassland": { "name": "grassland", "meta": {} },
    "forest": { "name": "forest", "meta": {} },
    "swamp": { "name": "swamp", "meta": {} },
    "rocky": { "name": "rocky", "meta": {} },
    "wilderness": { "name": "wilderness", "meta": {} },
    "village": { "name": "village", "meta": { … } },
    "stone-circle": { "name": "stone-circle", "meta": { … } }
  },
  "regionOfTile": [4, 4, 4, …],   // 每格所属区域索引（number[]，行主序），指向 regions 的键序
  "version": "b5f2b031"           // 内容指纹（8 位小写十六进制）：同内容恒定、内容变化即变；客户端可作缓存键
}
```

> 上例中的具体数值（含 `version` 指纹与各数组内容）均为**示例值，以实际响应为准**——地形每次改动 `version` 都会变化，客户端不要把示例中的指纹当作稳定值缓存。

字段说明：

| 字段 | 说明 |
|------|------|
| `key` | 地图 registry key。客户端应校验 `key` 等于请求的 `mapId`，不符则告警并拒绝应用（防错图） |
| `grid` | 网格尺寸与 tile 尺寸；`width`/`height` 为 tile 数 |
| `tiles` | 每格地面语义 id（number[]，行主序，长度 = width×height，索引 = `y*width+x`）。服务端不解释语义含义（映射在游戏配置）；客户端自备 id→颜色/贴图色表 |
| `walkable` | 每格通行位图（number[]，行主序）：**1=可走，0=阻挡**。⚠️ 与旧版 chunked `blocked` 位图语义相反（旧：1=阻挡）；按旧语义渲染会把整图画反 |
| `regions` | 区域名 → 区域元信息 `{name, meta}` 的普通对象。键顺序 = `regionOfTile` 的索引序（第 0 个键 = 索引 0） |
| `regionOfTile` | 每格所属区域索引（number[]，行主序），指向 `regions` 的键序 |
| `version` | 内容指纹（8 位小写十六进制）。同一地图内容恒定则值恒定，内容变化则变化。客户端可用 `{key, version}` 作缓存键，跳过重复拉取；响应头 `x-map-version` 与之同值，可只看响应头预检 |

`mapId` 参数语义：

- 省略 `mapId`：返回默认地图（game.json `map.default`，即 `/maps/meta` 的 `default` 字段）。
- 未知 `mapId`（含空串 `?mapId=`）：返回 404，错误体附可用图列表，例如 `{"error":"unknown map","available":["island","cave","tiled-demo","swamp","ruins"]}`。
- `mapId` 是**本次 HTTP 请求关心的地图 key**（客户端通常取自己的 `players.get(room.sessionId).mapId` 作为参数），与 per-player 当前地图字段同义但归属于**请求**——`RoomState` 级 `mapId` 已不存在，客户端不要读房间根状态。响应 `key` 与请求不符时告警并拒绝应用（防错图）。

`/maps/meta` 返回示例（**以当前 game/ 配置「荒岛求生」为例**）：

```jsonc
{
  "default": "island",
  "maps": [
    { "id": "island", "name": "island", "kind": "noise-terrain", "width": 192, "height": 192, "tileWidth": 16, "tileHeight": 16, "version": "b5f2b031" },
    { "id": "cave", "name": "cave", "kind": "noise-terrain", "width": 64, "height": 64, "tileWidth": 16, "tileHeight": 16, "version": "3258f81b" },
    { "id": "tiled-demo", "name": "tiled-demo", "kind": "tiled-source", "width": 8, "height": 8, "tileWidth": 16, "tileHeight": 16, "version": "52549583" },
    { "id": "swamp", "name": "swamp", "kind": "noise-terrain", "width": 96, "height": 96, "tileWidth": 16, "tileHeight": 16, "version": "a1c3e5f7" },
    { "id": "ruins", "name": "ruins", "kind": "slot-rooms", "width": 64, "height": 64, "tileWidth": 16, "tileHeight": 16, "version": "9d2b4c6e" }
  ]
}
```

> 上例中的 `version` 指纹均为**示例值，以实际响应为准**——地形内容每次改动指纹都会变化，客户端不要把示例中的指纹当作稳定值缓存。

> 字段说明：`id`/`name` = 地图 registry key（当前两者同值）；`kind` = 生成管道首积木注册名（如 `noise-terrain`/`tiled-source`）；`version` 与 `/maps/runtime` 响应体及 `x-map-version` 响应头同值。旧版的 `generatorId`/`seed` 字段已移除。

> 用法：客户端可先请求 `/maps/meta` 列出可用地图与各自 `version`（预检版本、渲染地图选择 UI），再按需请求 `/maps/runtime?mapId=<key>` 拉取具体地图数据。

### 5.3 地图内容：生成管道 / 校验 / Tiled 制作

> 本节补充地图「如何产生、是否可用、如何手工制作」的服务端视角（§5.2 已讲客户端如何拉取）。地图数据由 `game/maps/registry.json` 声明：`kind: "pipeline"` 走生成积木管道，`kind: "tiled"` 走外部 Tiled JSON 文件。客户端关注的是最终 `MapGeometry`（网格、地面语义 `tiles`、`walkable` 通行位图、`regions`/`regionOfTile` 区域位图；出生点不在几何模型——玩家出生只由 `game/rules/player.json` 的出生规则决定，演化规则产出实体/NPC/传送门等，不决定玩家出生点），其规则如下。

#### 5.3.1 生成积木管道（pipeline）

`kind: "pipeline"` 条目按**生成积木管道**产出几何：`seed` 派生确定性随机流，`pipeline[]` 逐积木在几何草稿上改写（首积木负责设定尺寸并分配缓冲）。框架内置一批**生成积木**，常用者如下（完整清单以 `pnpm tools list-registries` 输出为准）：

| 积木 | 说明 |
|------|------|
| `noise-terrain` | 首积木：设定网格尺寸，按分形噪声铺地面语义带（`bandLevel`/`falloff` + `groundPalette` 决定语义分布，`nonWalkableSemantics` 声明不可走语义） |
| `climate-regions` | 在地形上划分命名区域（`names[]` 顺序 = 区域索引序；未认领格归隐式区 `wilderness`；`minArea` 约束区域最小面积） |
| `smooth-terrain` | 后处理变换：局部多数平滑地面语义 + 重派生 walkable |
| `room-corridor` | 洞穴式房间 + 走廊雕挖（union-find 保证连通） |
| `tiled-source` | 加载外部 Tiled JSON 并降级为积木（见 §5.3.3） |
| `stamp-template` | 把 Tiled 模板盖印到草稿（ground/collision/zones 三层约定；zones 追加为区域） |
| `region-stats` | 区域派生统计：面积/质心/包围盒写入区域元信息 |
| `height-channel` | aux 辅助通道生产者：生成 height 场（不进快照，仅供下游积木消费） |
| `height-mask` | aux 辅助通道消费者：按 height 场遮罩 walkable 或写入区域高度统计 |
| `slot-rooms` | 槽位网格房间布局（锚点式布局 + 走廊/分支连通，连通性由构造保证） |

`kind: "pipeline"` 条目示例（**以当前 game/ 配置「荒岛求生」为例**——摘自 `game/maps/registry.json` 的 island 条目；尺寸/阈值/区域名均为配置产物）：

```jsonc
{
  "kind": "pipeline",
  "seed": 1337,                  // 随机种子，同 seed 同管道可复现
  "initialAgeTicks": 155520000,  // 开机初始演化跨度（实体规则按此补差）
  "pipeline": [
    { "generator": "noise-terrain",
      "params": { "width": 192, "height": 192, "tileWidth": 16, "tileHeight": 16,
                  "bandLevel": 0.35, "falloff": 0.25,
                  "groundPalette": { "1": 0.35, "2": 0.45, "3": 0.55, "4": 0.68, "5": 0.8, "6": 1 },
                  "nonWalkableSemantics": [1] } },
    { "generator": "smooth-terrain", "params": { "maxRounds": 4, "nonWalkableSemantics": [1] } },
    { "generator": "climate-regions",
      "params": { "names": ["beach", "grassland", "forest", "swamp", "rocky"], "style": "noise", "minArea": 800 } },
    { "generator": "stamp-template", "params": { "tiledPath": "templates/pig-village.json", "region": "grassland" } },
    { "generator": "stamp-template", "params": { "tiledPath": "templates/stone-circle.json", "region": "rocky" } },
    { "generator": "region-stats", "params": {} }
  ]
}
```

实体/NPC 的布置不在地图条目里声明：生物分布由**生态声明层**（`game/ecosystems.json`，按 biome×density 展开）与**实体演化规则**（`game/maps/entity-rules.json`，portal/建筑组等结构规则）按图/区域补差产出，玩家出生点由 `game/rules/player.json` 的出生规则决定。旧版的 `generatorId`/`npcSpawns` 字段已随地图系统重设计移除。

#### 5.3.2 地图校验（validateMapGeometry）

`buildMapGeometry` 在管道出口处统一调用 `validateMapGeometry` 做**结构校验**。校验器发现硬错误即抛错（消息含地图 key 与全部问题），软告警逐条 `logger.warn`（scope `build-map`）。

| 级别 | 触发条件 | 表现 |
|------|----------|------|
| 硬错误（HARD ERROR） | 网格为空（width/height ≤ 0）；`tiles`/`walkable`/`regionOfTile` 任一长度 ≠ width×height；`regions` 为空；`regionOfTile` 索引越出 regions 数量范围 | `buildMapGeometry` 抛出异常 → 该地图**不可用**（构建失败） |
| 软告警（SOFT WARNING） | 已声明的区域零覆盖（没有任何格属于它）；可通行连通性——全图不可走，或可走区分裂为多个 4-邻接连通域且最大域占比 < 0.9 | `logger.warn` 记录，**不阻断**构建 |

「地面语义 → 通行位图」一致性**不在此校验**（本层无语义上下文）：该一致性由各生成积木自行保证，并以积木单测覆盖。

影响面：`tools/gen-map`、`tools/export-map` 与 HTTP 端点（`/maps/meta`、`/maps/runtime`）都经 `buildMapGeometry` 构建几何，因此：

- **硬错误** = 命令非 0 退出 / 端点无法返回该图数据（该图无法产出几何快照）；
- **软告警** = 命令照常成功，日志出现该图的结构性警告（零覆盖区域 / 连通性）。

客户端效应：一个「必坏图」不会出现在可用的地图数据里，客户端按拉图失败处理即可；正常地图恒可成功构建。

#### 5.3.3 Tiled 地图制作与注册

若需手工制作静态地图，用 [Tiled](https://www.mapeditor.org/) 编辑器绘制后导出为 JSON，再经服务端解析。依赖**固定图层名**，解析约定如下：

| 图层 | 类型 | 约定 |
|------|------|------|
| `collision` | tilelayer | 阻挡层：非 0 的 tile 写入 `walkable=0`（阻挡），其余格可走 |
| `zones` | objectgroup | 区域：`type="zone"` 的对象转为命名区域（`zoneId` 保留进区域元信息）；有 `polygon` 用多边形顶点，否则兜底为矩形（`x/y/width/height` 围成）；区域外格归隐式区 `wilderness` |
| `objects` | objectgroup | **不再消费**（历史约定）：出生点已移出几何模型，实体/NPC 布置走实体演化规则（§5.3.1） |

根字段：`width` / `height`（tile 数）、`tilewidth` / `tileheight`（单格像素）。对象坐标均为 Tiled 的像素世界坐标（原点左上角）。

注册步骤：

1. 把 Tiled 导出的 JSON 保存到 `game/maps/`（如 `tiled-demo.json`）。
2. 在 `game/maps/registry.json` 的 `maps` 表加入 `kind: "tiled"` 条目（条目键即地图 key），`path` 指向该 JSON；之后用该 key 引用它（`/maps/runtime?mapId=<key>`、`players.get(room.sessionId).mapId`（per-player 当前地图）、传送门 `targetMap` 等）。

```jsonc
{
  "maps": {
    "tiled-demo": {
      "kind": "tiled",
      "path": "tiled-demo.json",
      "initialAgeTicks": 0
    }
  }
}
```

> 示例：`game/maps/tiled-demo.json` 是一张手工绘制的示例图，注册为地图 key `tiled-demo`（由独立任务产出，此处不列举其具体内容）。`kind: "tiled"` 条目经 `tiled-source` 积木构建为几何，出口同样接受 §5.3.2 的校验。

---

## 6. 对接清单（Checklist）

1. 声明 §3.4 的 Schema（字段名/类型/顺序严格一致）。
2. `joinOrCreate("game")`，记 `room.sessionId`。
3. 每帧发 `input`（seq 递增，速度不超过 server 规则上限）；按键边沿发 interact/attack/talk。
4. 渲染：遍历自己的 `players.get(room.sessionId).visibleEntities`（唯一实体来源）。
5. 按 §3.6 辨识实体种类，按 §3.5 读字段。
6. UI 操作 → `command`（§2.2），失败以状态回退为准。
7. 用 `/maps/runtime` 拉取地图几何快照，初始化地图渲染与碰撞（出生点不在几何模型，不从地图数据取）。

---

## 7. 常见问题

| 现象 | 原因 |
|------|------|
| 连接失败/握手无响应 | Schema 与服务端不一致（字段顺序/类型）、地址错误、CORS 白名单未含客户端 Origin |
| 角色不动 | 输入超速被拒（超限帧被丢弃、seq 不推进、无需重发）；或未发 `input`（只发 state 监听） |
| 实体表为空 | 实体恒在自己 `visibleEntities`（首帧后才开始填充）；若持续为空，检查是否同一地图/半径内无实体、或 Schema 声明顺序与服务端不一致 |
| 命令"没反应" | 命令失败无回执：缺料/满包/频率超限/距离不够，观察状态确认 |
| 断线重进后实体变了 | 服务端重启恢复存档，未到存档周期的最后变更会丢（周期由 server 规则 `saveIntervalMs` 配置） |
| 换图后实体全变 | 正常：该玩家 `PlayerState.mapId` 变化 = 该玩家场景切换，实体集随图切换（玩家自身保留）；其他玩家不受影响 |
