# 服务端对接协议（客户端接入指南）

> 本文档是**独立协议契约**：任何 Colyseus 客户端项目（无论语言/引擎）仅凭本文档即可对接本服务端，
> **无需访问服务端源码**。文档中的消息格式、状态结构、字段语义以文档为准；若部署方明确告知协议有变更，以部署方为准。
>
> **机制 vs 配置产物**：本文规范的是协议**机制与形状**（Schema 字段/顺序、消息名与载荷形状、端点契约、校验与错误语义、特征辨识方法、命令白名单）；文中出现的具体数值/内容清单是当前部署游戏配置的**产物**（以「荒岛求生」配置为例标注），会随 `game/` 配置漂移，各节均标注其配置来源（`game/rules/*.json`、`game/items/`、`game/entities/`、`game/maps/registry.json`、`game.json`），客户端不应硬编码。
>
> 技术基线：`@colyseus/core` 0.18.23 + `@colyseus/schema` 5.0.43（二进制增量同步，WebSocket 传输）；配套 Godot Colyseus addon 0.18.9。协议版本号见 §1.4。

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
- **断线保留（缺省 5 分钟）**：会话断开后玩家实体**不立即销毁**，而是挂上「离线保留」标记继续存在（位置、背包、进度原样保留）。保留时长由 server 规则 `offlineRetentionTicks` 配置（**缺省 = tickRate × 300 秒**，即 20 tick/s 下 6000 tick ≈ 5 分钟）；配 `0` 表示关闭保留、恢复「断线即销毁」行为。
- **凭 networkId 复用（推荐客户端做法）**：客户端把断线前自己的 networkId 存到本地（localStorage），再次 join 时作为**可选 join 参数**回传：

  ```ts
  const saved = Number(localStorage.getItem("minClient.networkId"));
  const room = await client.joinOrCreate(
    "game",
    Number.isInteger(saved) && saved > 0 ? { networkId: saved } : undefined,
  );
  ```

  服务端**严格按该 networkId 匹配**「未到期的保留实体」：命中 → **复用同一实体**（同一 NetworkId、背包/进度不丢，返回的 `PlayerState.entityId` 与断线前一致）；未命中（未提供 / 已到期 / 不存在）→ 按出生规则**新建**实体。**绝不**按 FIFO 把他人或已过期的旧实体绑给新客户端。客户端据此判定「已恢复角色」还是「新角色」。

- **展示资料（可选）**：join options 还可带 `displayName`（≤32）、`characterId`（≤64）、`appearance`（不透明 JSON 字符串，≤2048）。服务端只做长度/类型规范化并随实体入档，**不校验真实性**；断线保留重连时已有非空字段不会被覆盖（防冒领改名）。见 `PlayerState.displayName/characterId/appearance`（§3.2）。
- 保留期内的实体对**所有**在线玩家**不可见**（不进状态快照），因此保留中的角色不会出现在别人的视野里；到期由服务端清扫销毁。
- 保留标记**随存档入档**：服务端重启后仍在保留期内的玩家实体依然保留（读档时恢复标记与到期 tick），重连窗口跨重启有效。

> 早期版本文档写「断线即销毁、重连新建」——**已过时**，以本节为准。

### 1.4 协议版本握手

服务端在 join options 中读取整数 `protocolVersion`，与当前 `PROTOCOL_VERSION`（当前为 `1`）比较：

| 客户端上报 | 服务端行为 | 客户端可见错误 |
|---|---|---|
| 未提供（旧客户端） | 记一次 warning，**放行** | — |
| 非整数（字符串/小数/NaN 等） | **拒绝加入** | `protocol-version-invalid client=<原值> server=1` |
| 整数但与服务端不同 | **拒绝加入** | `protocol-version-mismatch client=<n> server=1` |
| 与 `PROTOCOL_VERSION` 相同 | 放行 | — |

`protocolVersion` 与 `schemaVersion` 由 `GET /client/manifest` 一并下发（manifest 契约以部署方文档为准；端点尚未部署时可向部署方查询）。客户端应在每次 join 时携带：

```ts
const manifest = await (await fetch(httpBase + "/client/manifest")).json();

const room = await client.joinOrCreate("game", {
  // 既有可选参数（断线复用）照常保留
  networkId: savedNetworkId,
  // 协议版本：从 manifest 读取，不要硬编码
  protocolVersion: manifest.protocolVersion,
});
```

- 缺省不传仍可连接（旧客户端兼容），但破坏性 schema 变更后旧版本会被**明确拒绝**，而不是静默解码错位。
- 客户端使用的 schema 副本必须由服务端 schema codegen 生成（Godot：`godot-client/generated/schema.gd`，由 `pnpm schema:gen` 产出）；`schemaVersion` 仅用于诊断，**字段顺序仍以生成物为准**。
- 收到上述错误消息时应提示用户升级客户端，不要重试同一版本（重试必然再次被拒）。

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
  "talk": false,     // 可选：本帧按下"对话"键
  // 可选：动作目标/瞄准。服务端仍做范围/同图/同层校验，失败回退最近目标。
  "target": 123,     // 目标实体 networkId（attack/gather 优先使用）
  "aimX": 480,       // 瞄准点世界坐标 x（throw / 朝向回退）
  "aimY": 320        // 瞄准点世界坐标 y
}
```

约束：

| 项 | 值 |
|----|----|
| `seq` | 严格递增正整数；被拒输入不推进 seq、无需重发（下一条更高 seq 输入照常放行）。服务端在 `PlayerState.lastProcessedSeq` 回传**已接受**的最大 seq（CC-14），客户端据此丢弃过期预测/确认输入是否生效 |
| 速度上限 | `\|(moveX, moveY)\|` 受 server 规则速度上限限定（像素/秒），超出整条输入被拒。配置源 `game/rules/server.json` 以格/秒表达（`maxMoveSpeedTiles`，加载期按 `game.json` `world.tile` 换算为像素/秒；当前 2 格/s = 32 px/s） |
| 意图信号 | `interact` / `attack` / `talk` 为边沿触发（按下那帧置 true 即可，服务端消费后清除） |
| 目标/瞄准 | `target` 是 **networkId**（不是 eid）；`aimX/aimY` 是世界坐标（像素）。三者可选，缺省时服务端按最近目标/移动朝向回退；目标在动作前摇内死亡或离开则本次动作落空（不转移目标） |
| 权威模型 | 服务端权威：客户端**不要**自行预测位移，以状态同步为准 |

### 2.2 离散命令 — 消息名 `"command"`

```jsonc
{ "type": "craft", "recipe": "<recipeId>", "requestId": "c-17" }
```

`requestId` 可选（字符串）；原样回传在 `command-result` 中，用于把回执和本地 UI 操作对上。缺省时也会回一条（无 requestId）。

命令类型与参数：

| type | 参数 | 语义 |
|------|------|------|
| `consume` | `slot: number` | 食用背包 `slot` 槽物品（恢复生存需求） |
| `drop` | `slot: number` | 丢弃背包 `slot` 槽物品（生成地面掉落物实体） |
| `transfer` | `slot: number`, `toSlot: number` | 背包槽间移动/堆叠 |
| `transfer` | `target: number`（容器 NetworkId）, `slot: number` | **从容器取回**：把容器实体（尸体等）的 `slot` 槽物品移入本人背包（给 `target` 即为取回语义；不给 `target` 则是背包内换槽） |
| `craft` | `recipe: string` | 合成（`recipe` 引用 crafting 配置定义的配方 id，见 §4.4） |
| `craft-cancel` | `recipe: string` | 取消进行中的延时制作（按配方 id 取消；退料原子——退料放不下则整条拒绝） |
| `refuel` | `target?: number`（站点 NetworkId） | 给燃料型站点加燃料（`target` 缺省＝射程内最近的燃料站点） |
| `equip` | `slot: number` | 穿戴背包 `slot` 槽物品 |
| `place` | `slot: number`, `x: number`, `y: number` | 放置 kit 物品 → 生成建筑实体（世界坐标） |
| `deconstruct` | `target: number` | 拆除自己放置的建筑（target = 实体 NetworkId） |
| `throw` | `x?: number`, `y?: number`（世界坐标） | 投掷**武器槽**中声明了投掷档案的物品；瞄准点优先，缺省按最近敌人/移动朝向回退 |
| `dialogue` | `option: number` | 推进当前对话（选项索引，见 §4.6） |
| `offer` | `offer: TradeParty[]`, `ttlTicks?: number` | 发起交易：提交各方条款，发起方本人视为已确认 |
| `offer-accept` | `offerId: number \| string` | 确认目标报价（全部参与方确认后成交） |
| `offer-cancel` | `offerId: number \| string` | 取消目标报价 |

命令补充说明：

- `transfer{target,slot}`：服务端校验**同图 + 同层 + 射程**（取回距离 = place 规则 `containerRange`，缺省 64px）；背包满时按物品堆叠规则塞入，溢出部分留在容器。
- `craft-cancel{recipe}`：只取消**该配方**的进行中制作；退料（材料回背包）失败则整条取消被拒（不产生半成品）。
- `refuel{target}`：消耗背包中的燃料物品（物品表由 crafting 规则的 `fuel.items` 定义），站点燃料值增长；射程 = crafting 规则 `stationRange`。
- `throw{x,y}`：要求**武器槽**装备的物品带投掷档案（速度/寿命/半径/伤害/冷却由物品配置的 `throw` 段定义）；命中/寿命结束即销毁，服务端有独立冷却（客户端本地冷却只是提示）。

`offer` 的 `offer` 参数是交易条款数组（`TradeParty[]`），每项形如：

```jsonc
{ "party": 123, "give": [{ "container": "inventory", "kind": "<itemKind>", "count": 5 }], "take": [{ "container": "inventory", "kind": "<itemKind>", "count": 2 }] }
```

- `party` = 参与方的 **networkId**（客户端可见的稳定 id，如自己 `PlayerState.entityId`、对方实体 `EntityState.id`）；**不是**服务端内部 eid（客户端拿不到）。服务端在命令入口把 networkId 反查为内部实体，**解析失败即整条拒绝**。
- `give` = 该方给出的数量列表（成交时从其容器扣减），`take` = 该方收取的数量列表（成交时插入其容器）；`container` ∈ `inventory` | `ledger`，**可省略**（缺省按 `inventory` 背包处理，客户端只需给 `{kind, count}`）。
- 可选 `ttlTicks` 为报价有效期（tick 数，缺省不过期）；发起方本人视为已确认，`offer-accept` 由对方确认，全部参与方确认后成交。
- `offer-accept` / `offer-cancel` 的 `offerId`：**数字或数字字符串皆可**（客户端可直接回传 `RoomState.offers` 的 map 键原值——那是字符串形态）。
- 交易账本（ledger）状态**不进入状态同步**（§3.5 无对应 key）——交易由服务端权威推进，客户端以 `Inventory` 变化确认成交结果。
- **进行中的报价**经 `RoomState.offers` 同步（§3.1「报价摘要」）：发起方与接收方各自能看到该条，其他玩家看不到；成交/取消后条目消失。

约束：

| 项 | 值 |
|----|----|
| 频率上限 | 由 server 规则 `maxCommandsPerSec`（`game/rules/server.json`）限定（滑动窗口），超出被拒 |
| 失败语义 | 任何命令失败（缺料/满包/距离不够/无权拆除等）服务端零副作用，并回 `command-result { ok:false, code }`（见 §2.3）；客户端可用 `code` 提示，但最终状态仍以 `RoomState` 为准 |
| 命令不进入 `seq` 去重 | 重复发送会被多次执行，客户端自行防抖 |

---

### 2.3 下行通知 — 消息名 `"command-result"` 与 `"events"`

服务端主动推送两类消息，客户端用 `room.onMessage(type, handler)` 接收。

#### `command-result`

每条 `command` 都会回一条（包括守卫失败/参数非法）：

```jsonc
{ "requestId": "c-17", "type": "craft", "ok": false, "code": "no_item", "data": {} }
```

| 字段 | 说明 |
|---|---|
| `requestId` | 原样回传客户端上行的 `requestId`（未提供则省略） |
| `type` | 命令 type（便于日志/UI） |
| `ok` | 是否成功 |
| `code` | 失败原因码：`invalid` / `no_item` / `inventory_full` / `out_of_range` / `cooldown` / `rate_limited` / `dead` / `not_owner` / `blocked` / `unknown` |
| `data` | 可选附加数据（当前可能为空） |

> 回执是**授权结果**，不是状态同步：成功后仍以 `RoomState` 的变化为准。`unknown` 表示服务端无法在不复制规则的前提下细分，客户端按通用失败提示。

#### `events`

每 tick 批量推送本客户端可见的表现事件（无事件不发包）：

```jsonc
{
  "events": [
    { "seq": 1042, "tick": 88123, "type": "hit", "data": { "attacker": 7, "target": 12, "damage": 18, "crit": false, "damageType": "pierce" } },
    { "seq": 1043, "tick": 88123, "type": "action-phase", "data": { "actionId": "attack", "actor": 7, "target": 12, "phase": "active", "phaseIndex": 1, "tick": 88123 } }
  ]
}
```

- `seq` 是服务端全局单调序号；按客户端过滤后**会有空洞**，只保证严格递增。客户端按 `seq` 去重/判新旧，不要假设连续。
- 事件是**通知**，不是权威状态；缺失/重复都不应改变客户端以 `RoomState` 为准的最终状态。重连不补发历史事件。
- 服务端按受众过滤：`self`（仅当事人）、`nearby`（同图+半径）、`map`（同图）、`world`（全房间）。实体引用一律 **networkId**，不出现 eid。
- 部分事件的 `data` 会带可选 `sfx: string[]` / `vfx: string[]`（不透明播放 id，清单见 `/client/manifest` 的 `audio`/`vfx` 段）；无映射时键不存在。事件本身不携带音频/粒子资源路径。
- 首批事件类型：

| type | 典型受众 | data（实体均为 networkId） |
|---|---|---|
| `hit` | nearby | `attacker,target,damage,crit?,damageType?` |
| `death` | nearby | `victim,killer?,kind?` |
| `action-start` / `action-phase` / `action-hit` / `action-end` / `action-cancel` | nearby | `actionId,actor,target?,phase,phaseIndex?,tick,reason?` |
| `gather` | self | `actor,node?,items:[[kind,count]],xp` |
| `craft-start` / `craft-complete` / `craft-cancel` | self | `player,recipeId,outputs?/durationTicks?/finishTick?` |
| `quest-update` / `quest-complete` | self | `questId,state,count` |
| `achievement` | self | `player,achievementId,name?` |
| `level-up` | self | `player,level,skill?` |
| `respawn` | self | `player,mapId` |
| `item-break` | self | `player,kind?,slot?` |
| `raid-warning` | map | `remainingTicks` |
| `weather-change` | world | `weatherId,phaseId,intensity,tick` |
| `season-change` | world | `seasonId,dayIndex,tick`（仅季节 id 变化时发一次） |
| `map-change` | self | `from,to,mapVersion?` |
| `terrain-writeback` | map | `mapId,version` |

> 事件只覆盖服务端已接线的产生点；未列出的玩法反馈仍以状态 diff 为准。

---

## 3. 下行协议（状态同步）

Colyseus Schema 增量同步（补丁 + 全量握手）。**客户端必须声明与服务端一致的状态结构**，§3.4 给出完整可复制定义。

### 3.1 RoomState（房间根状态）

| 字段 | 类型 | 说明 |
|------|------|------|
| `tick` | uint32 | 逻辑帧号（tick 率由 game.json `tickRate` 配置；当前示例 20 帧/秒 = 50ms/帧） |
| `hour` | float64 | 世界小时 0–24（推进速率见下「昼夜语义」） |
| `phase` | uint8 | 0=白天，1=夜晚 |
| `players` | map\<string, PlayerState\> | key = sessionId |
| `weatherId` | string | 当前**天气 id**（配置字符串，如 `clear`/`rain`/`fog`/`drought`/`storm`；无环境规则时为空串） |
| `phaseId` | string | 当前**相位 id**（配置字符串，如 `mild`/`dry`/`wet`/`storm`；无环境规则时为空串） |
| `phaseProgress` | number | 当前相位内进度 **0..1**（float64；无环境规则时为 0） |
| `offers` | map\<string, string\> | 进行中的**报价摘要表**：key = 报价会话 id（字符串），value = 摘要 JSON 字符串（见下「报价摘要」） |
| `serverTimeMs` | float64 | **逻辑服务器时间**（毫秒）= `tick × fixedDtMs`（当前 20tps → 50ms/帧）。用于客户端插值/对账，不是墙钟；不要与 `Date.now()` 混用 |
| `dayIndex` | uint32 | **24 小时日计数**（daynight 规则；tick 0 为第 0 天/hour 8，跨午夜 +1）。无 daynight 规则恒 0。注意与相位周期索引区分 |
| `seasonId` | string | 当前季节 id（可选 `environment.seasons` 循环；配置字符串，未配置为空串） |
| `weatherIntensity` | float64 | 当前天气强度 0..1（来自 weather 条目的 `intensity`，未配置为 0） |

> **字段顺序即线协议**：上表顺序 = 服务端 Schema 声明顺序 = 客户端必须声明的顺序。新增字段一律**追加在末尾**（`players` 之后依次是 `weatherId`/`phaseId`/`phaseProgress`/`offers`/`serverTimeMs`），既有四项（`tick`/`hour`/`phase`/`players`）的字段索引不变。

> **昼夜语义**：`hour` 按 daynight 规则（`game/rules/daynight.json`）推进——每 `cycleLengthSec` 真实秒走完 24 世界小时（当前配置 600s ⇒ 1 世界小时 = 25 真实秒 ≈ 500 tick@20tps）；`phase` 在 `nightStartHour`/`nightEndHour` 边界切换（当前 19/5，支持跨午夜）。**天数**由 `dayIndex` 提供（CC-12：24h 日计数，tick 0 为第 0 天/hour 8，跨午夜 +1）；不要再用本地 `hour` 回绕累计。

> **环境（相位/天气）语义**：`phaseId`/`weatherId`/`phaseProgress` 三者同源于**当前 tick 的纯函数派生**（相位程序按绝对槽对齐；天气按「本槽所属相位」的候选+权重确定性抽样），配置源是 `game/rules/environment.json`。id 是**配置字符串**，服务端只透传、不解释其含义（含义随配置漂移，客户端不要硬编码具体取值集）。三者每帧随快照刷新。

> **固定时间步（CC-14）**：服务端用 accumulator 以 `fixedDtMs` 固定步长推进仿真（20tps → 50ms/帧），不会被单次回调的实际 delta 拉长/缩短；积压超过上限时丢弃余量（逻辑时间变慢），不会“补帧加速”。客户端插值用 `serverTimeMs` 或 `tick × 50ms`，不要用本地帧时间累加。

> **房间级状态**：`RoomState` 不再携带 `mapId` / `entities`。玩家的当前地图是 **per-player** 的，经 `PlayerState.mapId` 同步（见 §3.2），**不是**房间级字段；实体同步恒走 per-client 的 `PlayerState.visibleEntities`（见 §3.2），`RoomState` 内没有实体表。

#### 报价摘要（`RoomState.offers`）

- **key**：报价会话 id（字符串形式的十进制数字，服务端自增；用于 `offer-accept` / `offer-cancel` 命令的 `offerId`）。
- **value**：一段 JSON 字符串（**不是**嵌套对象，客户端需 `JSON.parse`）：

  ```jsonc
  { "from": 123, "to": 456, "give": [["wood", 2]], "take": [["shell", 5]] }
  ```

  | 字段 | 含义 |
  |------|------|
  | `from` | **发起方**的 networkId（即 `PlayerState.entityId` 语义的稳定 id） |
  | `to` | **接收方**的 networkId |
  | `give` | 发起方**给出**的物品：`[[kind, 数量], …]`（`kind` 为物品 kind 字符串） |
  | `take` | 发起方**收取**的物品：`[[kind, 数量], …]` |

  视角约定：**以发起方（`from`）为基准**——接收方视角相反（`give`↔`take` 互换）。

- **可见性（重要）**：服务端按参与方裁剪——**只有该报价的发起方/接收方能在自己的 `offers` 表里看到这条**，其他玩家的表中没有该条目。客户端读到的每一条都与自己相关，可直接渲染为「待处理报价」列表。
- **生命周期**：报价被**接受（成交）/取消/过期**后，该条目从表中移除（key 消失）。
- 交易账本（ledger）状态仍**不进入状态同步**（§3.5 无对应 key）——成交结果以 `Inventory` 变化为准。


### 3.2 PlayerState（每玩家）

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | string | 本连接 sessionId（等于 `room.sessionId`） |
| `entityId` | uint32 | 自己控制的实体 NetworkId（`players.get(room.sessionId).entityId`） |
| `mapId` | string | 该玩家**当前所在地图 id**（per-player）：仅当**该玩家自己**走进传送门触发换图时变化，其他玩家不受影响 |
| `visibleEntities` | map\<string, EntityState\> | 本玩家可见实体表（**唯一的实体来源**）：key = NetworkId 字符串，只含本玩家可见实体 |
| `mapVersion` | string | 玩家当前地图的几何内容指纹（`MapGeometry.version`），每 tick 同步；变化时用旧值作 `sinceVersion` 拉 `/maps/runtime` 增量（§5） |
| `displayName` | string | 玩家展示名（join options 自报，≤32 字符；空串=未设置，客户端回退「玩家」/networkId）。服务端不校验真实性 |
| `characterId` | string | 角色/外观预设 id（不透明字符串，≤64；空串=未设置） |
| `appearance` | string | 不透明外观 JSON 字符串（≤2048；客户端自行解析，非法 JSON 自行回退默认外观） |
| `lastProcessedSeq` | uint32 | 该玩家**已接受**的最大 input seq（通过去重+速度校验才推进）；超速/乱序/重复不推进。客户端用它丢弃过期预测、判断输入是否生效 |

**兴趣裁剪（重要）**：实体同步**恒**走每个玩家自己的 `visibleEntities`——自 per-player 协议起，`RoomState` 的 `entities` 已移除，**不存在**房间级实体表或兼容通道：
- 自己（`entityId` 对应实体）恒在表中；其他实体进入半径（由 server 规则配置，见 `game/rules/server.json` 的 `viewRadiusTiles`——格，加载期换算为像素；未配置时同图全量）才出现，离开即被删除。
- 客户端只遍历 `state.players.get(room.sessionId).visibleEntities`，无需再读任何房间级实体表。
- 该表仅对自己可见（服务端按连接过滤，经 `$filter` per-client 编码），不要假设能看到其他玩家的表。
- 跨图实体被过滤：玩家只看到**同一地图**（`PlayerState.mapId`）内的实体 + 半径内；换图后旧图实体随即从此表移除。
- 这是**唯一**的实体交付路径（破坏性变更，旧客户端读取 `RoomState` 的 `entities` 会失败）。
- **上游解码 bug 兜底（core 0.17.x 旧基线）**：旧版服务端上该表可能解码出空壳实体（`id` 非数字、`values`/`stringValues` 缺失），与正常实体同表混入且时好时坏。当前服务端基线已升至 0.18.23，但客户端仍建议**逐实体过滤**（仅使用 `typeof id === "number"` 的实体）并以可选链读取字段；空壳伴随控制台 `"refId not found"` 报错，属旧版上游 bug 的预期噪音。

### 3.3 EntityState（单实体）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uint32 | NetworkId（稳定标识，实体一生不变；同实体复用，重建不产生新 id） |
| `values` | map\<string, number\> | 数值字段，key = `"组件.字段"` |
| `stringValues` | map\<string, string\> | 字符串字段，key = `"组件.字段"` |
| `level` | int8 | 实体所在**离散层号**（0 起，缺省 0；楼层/多层的实体分层标识）。**末尾追加**——既有 `id`/`values`/`stringValues` 的字段索引不变，旧客户端前三项照常解码（只是读不到 `level`） |

**字段 key 约定**：
- SoA 标量：`"Transform.x"`、`"Health.current"`、`"Collider.shape"`（0=圆形 1=矩形）
- AoS 展平：`"Needs.0.name"`、`"Inventory.3.kind"`、`"Quest.0.state"`、`"Dialogue.0.option"`
- 组件索引位置稳定；**空槽有占位值**（如 `"Inventory.3.kind"` = `""`），"key 存在"不代表"有货"
- 同步是增量 diff：字段消失时（如对话结束、需求槽缩短、容器被清空）key 会被删除，读取注意 `undefined`

### 3.4 客户端 Schema 定义（可直接复制）

> 字段**顺序**是线协议的一部分：客户端声明必须与服务端一致，否则状态解析错乱。
> 服务端升级协议（增删字段）后需同步更新客户端定义。

```ts
import { Schema, MapSchema, type } from "@colyseus/schema";

export class EntityState extends Schema {
  @type("uint32") id: number = 0;
  @type({ map: "number" }) values = new MapSchema<number>();
  @type({ map: "string" }) stringValues = new MapSchema<string>();
  @type("int8") level: number = 0;   // 末尾追加：实体离散层号（0 起，缺省 0）
}

export class PlayerState extends Schema {
  @type("string") sessionId: string = "";
  @type("uint32") entityId: number = 0;
  @type("string") mapId: string = "";
  @type({ map: EntityState }) visibleEntities = new MapSchema<EntityState>();
  @type("string") mapVersion: string = "";   // 末尾追加：当前地图 version（旧字段索引不变）
  @type("string") displayName: string = "";  // 末尾追加（CC-10）
  @type("string") characterId: string = "";
  @type("string") appearance: string = "";   // 不透明 JSON 字符串
  @type("uint32") lastProcessedSeq: number = 0; // 末尾追加（CC-14）：已接受输入 seq
}

export class RoomState extends Schema {
  @type("uint32") tick: number = 0;
  @type("float64") hour: number = 8;
  @type("uint8") phase: number = 0;
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  // —— 以下四个字段追加在末尾（顺序即线协议）——
  @type("string") weatherId: string = "";        // 当前天气 id（配置字符串）
  @type("string") phaseId: string = "";          // 当前相位 id（配置字符串）
  @type("number") phaseProgress: number = 0;     // 当前相位进度 0..1
  @type({ map: "string" }) offers = new MapSchema<string>(); // 报价摘要：offerId → JSON 字符串
  @type("float64") serverTimeMs: number = 0;     // 末尾追加（CC-14）：逻辑时间 = tick × fixedDtMs
  @type("uint32") dayIndex: number = 0;           // 末尾追加（CC-12）：24h 日计数
  @type("string") seasonId: string = "";          // 末尾追加（CC-12）
  @type("float64") weatherIntensity: number = 0;  // 末尾追加（CC-12）：0..1
}
```

> 协议破坏性变更：`RoomState` 已移除 `mapId` 与 `entities`（旧字段顺序对齐的客户端会错位解码）；`PlayerState` 新增 `mapId`。字段**顺序**是线协议的一部分——客户端声明必须与服务端一致（见 §3.4 顶部提示），旧客户端解码新流会错位、需升级。
>
> **兼容性说明（`EntityState.level`）**：`level` 是**末尾追加**字段，既有 `id` / `values` / `stringValues` 三项的**字段索引不变**——旧客户端在结构上仍能解码新流（只是读不到层号）；新客户端连旧服务端则缺 `level`（按 0 处理即可）。
>
> **兼容性说明（`RoomState` 末尾字段）**：`weatherId`/`phaseId`/`phaseProgress`/`offers`/`serverTimeMs` 均为**末尾追加**，既有四项（`tick`/`hour`/`phase`/`players`）索引不变；旧客户端在结构上仍能解码新流（只是读不到这些字段）。`PlayerState` 的 `mapVersion`/`displayName`/`characterId`/`appearance`/`lastProcessedSeq` 同样只在末尾追加。


（非 TS/JS 客户端：以本表字段名/类型/顺序为准，用各自语言的 @colyseus/schema 绑定声明。）

### 3.5 同步字段清单（客户端可依赖的 key）

> 同步键由 `game.json` 的 `netSync.fields` 配置决定，客户端应以实际快照为准；下表为当前配置的产物（荒岛求生示例）。字段 key 只会有这些；**实体按"拥有哪些组件"决定带哪些 key**（§3.6）。

| 组件 | key 形态 | 语义 |
|------|----------|------|
| Transform | `Transform.x/y/rot/scale` | 世界坐标（像素，中心点）、旋转、缩放。`scale` 语义中性值为 1；若读到 0（旧存档/旧服务端未初始化），客户端按 1 处理 |
| Kind | `Kind.value` | 实体种类（原型 kind 字符串，如 `corpse` / `tree` / `boss_alpha`）——**客户端辨识实体的首选依据**（见 §3.6） |
| Category | `Category.value` | 框架通用分类（`player/enemy/npc/projectile/structure/resource/container/item/other`），服务端按标签/组件派生；客户端选渲染与交互路径时优先用它，无需用 `Health+Needs` 猜 |
| Space | `Space.exposure` | 玩家所在格的服务端派生空间语义：`indoor` / `outdoor`（头顶有板 + 围合判定）；用于室内外音效/天气/遮挡表现。仅玩家同步，缺省不写键 |
| Health | `Health.current/max` | 当前/最大血量（血条比例 = current / max） |
| Attack | `Attack.value/range` | 攻击力与射程（像素） |
| Defense | `Defense.value` | 防御力 |
| Team | `Team.id` | 阵营/队伍 id（友伤、仇恨分组依据） |
| Perception | `Perception.visionRadius` | 感知半径（像素） |
| Velocity | `Velocity.vx/vy` | 速度（像素/秒）；无输入时服务端清零，可用于走/停判定与插值 |
| Collider | `Collider.shape`, `Collider.radius` | 碰撞形状：0=圆形 1=矩形 |
| Size | `Size.w`, `Size.h` | 尺寸 |
| Needs | `Needs.{i}.name/current/max` | 生存需求（条目集与 name 由 needs 规则定义，见 `game/rules/needs.json`；任一为 0 持续扣血） |
| Inventory | `Inventory.{i}.kind/count` | 背包槽（容量由玩家原型配置定义；空槽 kind=`""` 占位） |
| Inventory | `Inventory.{i}.durability` | 槽位**当前耐久**（**仅逐实例有耐久的物品写键**；耐久上限不在协议内，由物品配置 `maxDurability` 定义） |
| Inventory | `Inventory.{i}.spoilAt` | 槽位**腐烂到期绝对 tick**（与 `RoomState.tick` 同一时间基；仅会腐烂且未腐烂的物品写键）。剩余 = `spoilAt - RoomState.tick` |
| ItemMeta | `ItemMeta.kind/count` | 地面掉落物 |
| ItemMeta | `ItemMeta.durability` | 地面掉落物当前耐久（同上，仅有耐久的物品写键） |
| ItemMeta | `ItemMeta.spoilAt` | 地面掉落物腐烂到期绝对 tick（语义同 `Inventory.{i}.spoilAt`） |
| ResourceNode | `ResourceNode.remaining/max/infinite` | 资源点剩余量 / 上限 / 无限标记（0=有限，1=无限）；`remaining=0` = 已枯竭（**实体不消失**；`regenMs=0` 永不自动恢复，>0 按毫秒回满） |
| Equipment | `Equipment.weaponSlot/toolSlot/armorSlot` | 装备槽引用的**背包槽索引**（-1=空） |
| Equipment | `Equipment.weaponKind/toolKind/armorKind` | 装备槽当前物品 kind（派生字符串；空槽不写键）。仅这三个装备槽，不暴露背包其他内容；用于渲染他人手持/护甲 |
| CraftingStation | `CraftingStation.stationType` | 合成站类型 id（类型语义由 crafting 配置定义；当前示例：0=通用，1=光源站点） |
| LightSource | `LightSource.radius/fuelRemainingMs/fuelInfinite` | 光源半径、剩余燃料（≤0 熄灭）、无限燃料标记（1=永不耗尽，不要显示倒计时） |
| Placeable | `Placeable.footprintW/footprintH/canCollide/ownerNetworkId` | 放置物占用/阻挡信息、放置者 networkId（0=无主/地图静态布置；拆除权限判断用） |
| Projectile | `Projectile.vx/vy/lifeMs/radius/damage` | 投射物速度（像素/秒）、剩余寿命（ms）、接触半径、伤害 |
| Projectile | `Projectile.ownerNetworkId` | 投射物主人的 networkId（0=无主/已销毁）；**服务端不下发 eid** |
| Structure | `Structure.role/connectLow/connectHigh/connectDir` | 建造角色（1=楼板 / 2=墙 / 3=连接器）与连接器连接区间、方向 |
| Passage | `Passage.open` | 可开合屏障（门）状态：1=放行 / 0=阻挡 |
| GridOccupancy | `GridOccupancy.cellX/cellY/cellW/cellH/cellLevel` | 建筑占用的网格与层号（多层建造判定） |
| Portal | `Portal.targetMap/x/y` | 传送门：目标地图与落点 |
| Dialogue | `Dialogue.npcId/treeId/nodeId/text`、`Dialogue.option.{i}.text`、`Dialogue.{i}.option` | 玩家对话会话（仅对话中出现的 key，见 §4.6） |
| DialogueSource | `DialogueSource.treeId` | NPC 挂载的对话树 id |
| Quest | `Quest.{i}.questId/state/count` | 玩家任务（state：0未接/1进行/2可交/3完成） |
| Relation | `Relation.{i}.npcKind/value` | 与 NPC 的好感值 |
| Progression | `Progression.totalXp/level` | 累计经验与服务端派生的角色等级 |
| Progression | `Progression.skill.{skillId}.xp/level` | 按技能 id 展开的技能经验/等级（skillId 由 progression 规则配置约定） |
| Achievements | `Achievements.{achievementId}` | 已解锁成就（数值 **1 = 已解锁**；id 由 achievements 规则配置约定） |
| Crafting | `Crafting.{i}.recipeId`（stringValues）、`Crafting.{i}.remainingTicks/progress/suspended`（values） | **进行中的制作**：`recipeId`=配方 id、`remainingTicks`=距完成剩余 tick（0=到点）、`progress`=时间进度 0–1（挂起时恒 1）、`suspended`=1 表示到点但产出条件未满足（背包满/站点失效）；任务完成/取消后整条消失 |
| Cooldown | `Cooldown.remainingMs` | 攻击/投掷冷却剩余毫秒（**所有带 Cooldown 的实体**，含玩家与敌怪；服务端权威、每帧递减）。供客户端显示冷却提示——但**冷却是否结束仍以服务端裁决为准**（冷却中发命令会回 `command-result code=cooldown`） |
| Action | `Action.actionId`（stringValues）；`Action.startedTick/durationTicks/phaseIndex/target/dirX/dirY`（values）；`Action.phase`（stringValues） | 当前动作时间轴（**仅玩家**）：`actionId`=配置动作 id，`startedTick`/`durationTicks`=动画进度基准（`(RoomState.tick - startedTick) / durationTicks`），`phase/phaseIndex`=当前阶段，`target`=目标 **networkId**（0=无目标），`dirX/dirY`=朝向单位向量。无动作时整组 key 消失；阶段/事件帧详见 §3.7 |
| Ledger | `Ledger.{kind}` | 账本/商店库存：按物品 kind 展平的计数（数值） |
| StateMachine | `StateMachine.state`（stringValues）、`StateMachine.stateTick`（values） | 通用状态机当前状态 id（配置字符串，如 `alive`/`burning`/`burnt`）与进入该状态的**绝对 tick**；动画进度 = `(RoomState.tick - stateTick) / 配置时长` |
| Modifiers | `Modifiers.{stat}.mul/add/count/bool/expiresTick`、`Modifiers.{stat}.source.{source}` | 生效中的属性修饰符投影（与 `computeStat` 同过期语义）：乘法/加法合计、条目数、bool 状态、最早失效绝对 tick、按来源计数。用于中毒/减速/狂暴等状态表现；整组失效时键消失 |
| ExpiresAt | `ExpiresAt.remainingTicks` | 一次性定时器剩余 tick（`max(0, expiresTick - tick)`）；不暴露效果参数 |
| Lifetime | `Lifetime.remainingTicks` | 持久寿命剩余 tick（尸体/掉落物 TTL 等，`max(0, expiresTick - tick)`）；到期由服务端清理 |

### 3.6 实体辨识（客户端如何知道"这是什么"）

服务端下发两级分类：`Category.value`（框架通用大类，见 §3.5）与 `Kind.value`（游戏原型 kind）。客户端应**先用 `Category.value` 选渲染/交互大类，再用 `Kind.value` 选具体贴图/动画/名称**；只有拿不到这两个字段（旧服务端）时，才回退到「同步字段组合」启发式。

| 特征 | 判定 |
|------|------|
| `Category.value` | **首选大类**：`player` / `enemy` / `npc` / `projectile` / `structure` / `resource` / `container` / `item` / `other` |
| `Kind.value` | **具体种类**：原型 kind 字符串（资源点/敌怪/尸体/建造物/首领/传送门…） |
| `ResourceNode.remaining` | 资源点（可采集）——无 kind 时的兜底 |
| `ItemMeta.kind` | 地面物品（可拾取） |
| `DialogueSource.treeId` | NPC（可对话） |
| `Health.current`（无其他特征） | 敌怪（可攻击） |
| `Health.current` + `Needs.*` | 其他玩家 |
| `CraftingStation.stationType` + `LightSource.*` | 光源型合成站（带燃料与照亮半径的合成站点） |
| `Portal.targetMap` | 传送门 |
| `Placeable.*` | 建筑 |

> 容器（可搜刮实体，如尸体）的判定：`Kind.value === "corpse"`，或该实体带 `Inventory.0.kind`（且不是玩家实体）。容器的物品清单经 `Inventory.{i}.kind/count/durability` 同步（§3.5），客户端据此渲染搜刮面板并用 `transfer{target,slot}` 取回（§2.2）。

### 3.7 动作时间轴（Action.*）

`attack` / `gather`（采集）/ `throw` 不再当帧瞬时结算，而是**服务端权威的动作过程**（place/deconstruct/consume/dialogue 仍为瞬时）。

- 动作开始时同步 `Action.startedTick/durationTicks/phase/phaseIndex/target/dirX/dirY`；
- 阶段区间为 `[上一阶段 endTick, 本阶段 endTick)`，事件（伤害/采集/生成投射物）在**进入**事件阶段时由服务端结算一次；
- 客户端动画进度用 `(RoomState.tick - Action.startedTick) / Action.durationTicks`，阶段边界从 `Action.phaseIndex/phase` 变化或 `durationTicks` 与配置的 `phases[].endTick` 推导（动作配置由部署方提供，客户端不应硬编码时长）；
- 动作期间移动可能被锁（服务端 `Velocity=0`）；动作结束/死亡/换图/打断时整组 `Action.*` key 消失；
- `Action.target` 是 networkId；目标在前摇内死亡/离开则本次动作落空（recovery 仍走完），客户端不要自行把伤害/采集结果提前到本地；
- 冷却仍以 `Cooldown.remainingMs` 为准（动作开始时起算，事件结算后按原子规则刷新）。

当前部署配置示例（仅说明形状，客户端不得硬编码）：attack 12 tick（windup 4 / active 7 / recovery 12）、gather 10 tick（windup 3 / swing 6 / recovery 10）、throw 8 tick（windup 4 / release 5 / recovery 8）。

---

## 4. 玩法机制（协议映射）

> 本节规范玩法对应的**协议机制**；具体数值/内容清单是游戏配置的产物，随 `game/` 配置漂移，客户端不应硬编码判定——「当前配置来源」列给出各类值的定义处。

| 玩法 | 操作 | 服务端反应 | 当前配置来源 |
|------|------|-----------|-------------|
| 移动 | `input` moveX/moveY | 速度积分 + 碰撞分离 → `Transform.x/y` 同步 | 速度上限 = server 规则（`game/rules/server.json` 的 `maxMoveSpeedTiles`，格/秒，加载期换算为像素/秒） |
| 采集 | `input` interact（可带 `target` networkId） | 启动 gather 动作 → swing 阶段对半径内资源实体结算 → `ResourceNode.remaining` 减少 → 物品入包/落地 | 交互半径 = `game.json` `systems[].config`（interaction 的 `range`）；动作时长/阶段见 §3.7 |
| 近战攻击 | `input` attack（可带 `target` networkId） | 启动 attack 动作 → active 阶段结算目标 `Health.current`；击杀按 LootTable 落地掉落物 | 攻击射程取实体 `Attack` 组件值，缺省回退 combat 规则（**组件值优先**）；冷却/无友伤/伤害公式见 `game/rules/combat.json`；动作时长/阶段见 §3.7 |
| 拾取 | 无操作（走近自动） | 地面物品消失 → `Inventory` 计数增加 | 自动拾取 + 防瞬回保护（落地后短暂不可拾，框架行为） |
| 对话 | `input` talk → `command dialogue` | 见 §4.6 | 对话半径 = dialogue 规则 `talkRange`（未配置用框架缺省）；talk 路由半径同 interaction 配置 |
| 合成 | `command craft` | 消耗材料 → 产出入包（缺料/满包/站点不符零副作用） | 配方集由 `game/rules/crafting.json` 定义（§4.4）；站点判定半径 = crafting 规则 `stationRange` |
| 延时制作 | 被动（`Crafting.{i}.*` 同步） | 制作计时推进，到点后产出（背包满/站点失效则挂起，`suspended=1`） | 制作时长 = 配方的 `durationTicks`；延时/解锁条件见 §4.4 |
| 取消制作 | `command craft-cancel` | 取消进行中的制作并退料（退料放不下则整条拒绝） | 制作时长/条件同 crafting 配置 |
| 容器取回 | `command transfer{target,slot}` | 容器槽物品 → 本人背包 | 取回距离 = place 规则 `containerRange`（缺省 64px）；同图/同层校验 |
| 加燃料 | `command refuel` | 消耗背包燃料物品 → 站点 `LightSource.fuelRemainingMs` 增长 | 射程 = crafting 规则 `stationRange`；燃料物品表 = crafting 规则 `fuel.items` |
| 投掷 | `command throw{x,y}` | 武器槽投掷档案物品 → 投射物实体（直线飞行、命中/寿命结束销毁） | 投掷参数（速度/寿命/半径/伤害/冷却）由物品配置 `throw` 段定义；冷却剩余毫秒经 `Cooldown.remainingMs` 同步（所有带冷却的实体），**是否放行仍由服务端裁决** |
| 装备 | `command equip` | `Equipment` 三槽更新，攻击/采集加成即时生效 | 槽位 weapon/tool/armor 是协议形状；加成数值由物品配置（`game/items/`）定义 |
| 食用/丢弃 | `command consume/drop` | 需求恢复 / 地面掉物 | 食用恢复量由物品配置（`game/items/`）定义 |
| 放置 | `command place` | 校验后消耗 1 个 kit → 生成建筑实体 | 放置距离/网格吸附由 place 规则（`game/rules/place.json`）配置 |
| 拆除 | `command deconstruct` | 仅放置者可拆、范围校验、不返还材料 | 范围同 place 规则 `placeRange` |
| 任务 | 对话选项触发 | 见 §4.7 | 任务定义见 `game/quests/`，经对话树（`game/dialogues/`）选项效果挂接 |
| 成长/成就 | 被动（`Progression.*` / `Achievements.*` 同步） | 经验累计 → 等级/技能等级派生；成就解锁写入世界账本并投影到玩家实体 | 曲线与技能由 `game/rules/progression.json` 定义；成就由 `game/rules/achievements.json` 定义（见 §4.8） |
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
- **延时制作**：`durationTicks` 非 0 的配方在制作期间挂出 `Crafting.{i}.*`（§3.5）；`craft-cancel{recipe}` 按配方 id 取消（同一配方同一时刻至多一个任务）。
- **解锁条件**：配方可带 `unlock.condition`（条件串，如 `inPhase:storm`、`progressAtLeast:<kind>:<n>`）。条件语义由配置约定，**服务端裁决**——客户端可把条件渲染成提示，但**不要**据此禁止发命令（失败会回 `command-result`，部分条件失败可能归为 `unknown`，见 §2.3）。

### 4.5 建造

- `place` 消耗 1 个 kit 类物品生成建筑实体（放置距离/网格吸附由 place 规则 `game/rules/place.json` 配置）。
- 建筑默认是静态阻挡（是否阻挡由实体配置的碰撞属性决定）；`deconstruct` 仅放置者可拆。
- 建筑实体带 `Placeable.*` / `GridOccupancy.*` key（占用网格由服务端吸附计算，客户端只读）；带层结构的建造物另有 `Structure.*`（角色/连接器）与 `Passage.open`（可开合屏障）key。

### 4.6 对话

1. `input { talk: true }` → 半径内最近 NPC 开始对话。
2. 服务端同步 `Dialogue.*` key：

   | key | 位置 | 含义 |
   |------|------|------|
   | `Dialogue.treeId` | stringValues | 对话树 id |
   | `Dialogue.nodeId` | stringValues | 当前节点 id |
   | `Dialogue.text` | stringValues | **当前节点的正文**（对话气泡内容） |
   | `Dialogue.option.{i}.text` | stringValues | **第 i 个选项的文案**（按钮文本） |
   | `Dialogue.{i}.option` | stringValues | 第 i 个选项文本（历史键，与 `option.{i}.text` 同值，保留兼容） |
   | `Dialogue.npcId` | values | 对话对象的 networkId |

3. 客户端渲染正文（`Dialogue.text`）与选项按钮（`Dialogue.option.0.text`、`Dialogue.option.1.text`…），选第 i 项 → `command { type: "dialogue", option: i }`。
4. 服务端执行选项效果（接/交任务、好感）；**效果失败停留在当前节点**（可重试）；`__end__` 选项结束对话（`Dialogue.*` key 消失）。
5. NPC 实体带 `DialogueSource.treeId`（树 id），用于区分不同 NPC 的对话。

### 4.7 任务

- 任务挂在玩家实体上：`Quest.{i}.questId/state/count`。
- 接取/提交都通过**对话选项效果**触发（不是独立命令）。
- 进度：collect 型随背包变化实时更新；kill 型击杀目标后更新；`state=2`（可交）时回到 NPC 对话选提交选项 → 消耗任务物品 + 发奖励 + 好感 + `state=3`（完成）。
- 任务 id 与任务名称的对应关系由 `game/quests/quests.json` 定义，**协议只同步 id**——客户端展示中文名需自行映射（静态表或宿主注入）。

### 4.8 成长、成就与容器（静态表 vs 协议）

**协议只同步「数值与 id」，不枚举内容**——中文名/描述统一从 **`GET /content`**（§5.2.1）拉取，不必再自备静态表（该端点是当前 `game/` 配置的服务端单一来源，内容随配置漂移）：

| 展示内容 | 协议来源（id / 数值） | 名称/描述来源（`/content`） |
|----------|----------------------|------------------------|
| 角色等级与经验 | `Progression.totalXp` / `Progression.level` | 等级曲线 `game/rules/progression.json`（`curve`：baseXp / growth / maxLevel） |
| 技能等级与经验 | `Progression.skill.{skillId}.xp` / `.level` | `skills[].id/label`（`/content` 的 `skills` 段） |
| 已解锁成就 | `Achievements.{achievementId}` = 1 | `achievements[].id/title/desc`（`/content` 的 `achievements` 段） |
| 任务名称与目标 | `Quest.{i}.questId` / `.state` / `.count` | `quests[].id/title/desc`（`/content` 的 `quests` 段） |
| 容器物品清单 | `Inventory.{i}.kind/count/durability` | `items[].kind` + 物品定义字段（`/content` 的 `items` 段；**耐久上限**也在其中） |
| 配方名称与解锁条件 | `Crafting.{i}.recipeId` | `recipes[].id/desc/unlock`（`/content` 的 `recipes` 段） |
| 物品名称 | `Inventory.{i}.kind` / `ItemMeta.kind` | `items[]`（`/content` 的 `items` 段；含堆叠上限/耐久/食用/穿戴/放置/投掷档案） |
| 环境相位与天气 | `RoomState.phaseId/phaseProgress/weatherId/weatherIntensity/seasonId/dayIndex` | `phases[].id/durationTicks/weather(intensity)/modifiers` 与 `seasons[]`（`/content`） |

> 兼容说明：`/content` 不可用时（旧服务端）客户端仍可退回到自备静态表的旧做法——协议本身不依赖该端点。

- 等级曲线语义：等级 L（1 起）升到 L+1 所需经验 = `round(baseXp × growth^(L-1))`；**累计**经验跨级累加，服务端按此派生 `level`。客户端若要画经验条，须用同一公式换算「本级进度」。
- 成就解锁是**世界级事实**（随存档恢复），按实体投影到玩家实体（`Achievements.<id>` = 1）；客户端可用「key 由无到有」判定**新解锁**并提示（重连时既有成就不应重复提示）。
- 容器的 `Inventory.{i}.*` 与玩家背包同形（空槽 kind=`""` 占位）；取回走 `transfer{target,slot}`（§2.2）。

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
| `GET /client/manifest` | **客户端静态契约**：协议/内容/schema 版本、tickRate、world tile、serverRules、netSync 字段表、地图+图块语义、实体表现、物品索引；带强 `ETag`（=`contentVersion`）与 `If-None-Match` 304。见 §1.4 |
| `GET /content` | **内容目录**（静态表的单一来源，见 §5.2.1） |
| `GET /maps/runtime?mapId=<key>&sinceVersion=<v>` | 地图几何快照。无 `sinceVersion`：全量（`tiles`/`walkable`/`level`/`regions`/`regionOfTile`/`version`）；`sinceVersion` 等于当前：`{key,version,unchanged:true}`；已知历史版本：`{key,version,baseVersion,modifications:[{tileIndex,field,value}]}`；未知版本回退全量。`mapId` 省略时返回默认图；未知 key 404。见下方增量说明 |
| `GET /maps/meta` | 地图清单：默认图 key 与全部地图的元信息（含 version）。客户端可先拉取清单列出地图、预检版本，再按需拉取 runtime |
| `GET /maps/render?mapId=<key>` | **有效地面**：`{key,baseVersion,renderVersion,phaseId,phaseProgress,tiles}`；`tiles` 是当前相位/天气派生后的逐格语义（不写回底板），`renderVersion` 是缓存键 |
| `GET /maps/collision?mapId=<key>&level=<n>` | **正式静态碰撞/占用**：`{key,version,level,grid,walkable,occupants}`；`walkable` = 该层地形+楼板通行位，`occupants` 用 networkId（不是 eid）。用于放置预览/客户端碰撞镜像/遮挡 |
| `GET /maps/decor?mapId=<key>` | 确定性装饰点集：`{key,version,points:[{decorId,x,y,level,region,variant}]}`（不是实体、无碰撞；`x-map-version` 同 runtime） |
| `GET /world/map-graph` | 世界图：`{maps:[{id,displayName,connections:[{to,kind,x?,y?}]}]}`（数据来自 presentation，缺省回退 registry） |
| `GET /query/affordances?player=<networkId>&x&y&level&radius` | 交互候选：附近实体的可执行动作与不可用原因（gather/attack/talk/open/loot/place/deconstruct） |
| `POST /query/place` `{player,slot,x,y}` | 放置预览：`valid/reason/footprint/cells/occupiedBy/ownerNetworkId`（与 place 命令同一校验） |
| `POST /query/craft` `{player,recipeId}` | 合成预览：`unlocked/station/missing/durationTicks/available/reason`（与 craft 命令同一校验） |
| `GET /query/shop?npc=<networkId>&player=<networkId>` | 商店：货币、库存、**实价**（关系/势力/相位/供需后的价格） |
| `GET /query/quests?player=<networkId>` | 任务静态定义 + 运行时 `state/count` |
| `GET /query/achievements?player=<networkId>` | 成就定义/条件/奖励 + `unlocked` |
| `GET /query/skills?player=<networkId>` | 技能曲线/加成 + 运行时 `xp/level` |
| `GET /debug/colliders` | 房间碰撞体调试快照（房间未就绪时 404；调试用，不是正式碰撞源） |

> **地图几何来源（live 优先）**：`/maps/runtime` 与 `/maps/meta` 优先返回**活动房间的实时几何**（含运行期写回的结果，如野火焦土——`tiles`/`walkable`/`level` 已变，`version` 指纹随之变化）；房间未就绪（服务刚启动、或房间创建失败）时回退为「按配置重建」的视图。两种视图在**没有任何写回**时内容一致，因此客户端按 `{key, version}` 缓存仍然安全；若运行期发生地形改写，`version` 会变，客户端据此重新拉取。

> **装饰点（CC-13）**：`/maps/decor` 返回按区域/密度规则确定性生成的装饰点（`decorId/x/y/level/region/variant`），**不是实体**、不参与碰撞/交互、不进视野表；客户端按 `decorId` 绑定贴图/变体，自己处理邻接与遮挡排序。`manifest.decor.ids` 给可用 id 清单；地图写回后 `version` 变化，按 `x-map-version` 重拉。

> **manifest 的音频/VFX 段（CC-11）**：`audio = { music: string[], ambient: string[], sfx: string[], events: { [eventType]: string[] } }`，`vfx = { effects: string[], events: { [eventType]: string[] } }`。客户端按 id 绑定本地资源；`maps[].musicId/ambientId` 用于换图后的音乐/环境音切换；`decor.ids` 为装饰 id 清单。`animations` 当前仍为空对象。

> **地图版本订阅（CC-05）**：`PlayerState.mapVersion` 每 tick 同步玩家当前地图的 `version`。客户端检测到它变化时，用上次的 `version` 作为 `sinceVersion` 请求 `/maps/runtime` 增量（`modifications` 为稀疏终态，直接覆盖对应格即可，不要按事件流重放）。增量只覆盖 `tiles/walkable/level`；`regions/regionOfTile` 与 grid 变化只能靠全量（当前运行期写回不改区域/grid）。未知/过旧 `sinceVersion` 会自动回退全量，客户端按响应里有没有 `modifications` 分支处理即可。

> **有效地面 vs 底板**：`/maps/runtime` 的 `tiles` 是**底板**（写回后的持久值）；`/maps/render` 的 `tiles` 是**当前 tick 的有效地面**（相位/天气覆盖派生，如季节雪地/湿润地面，不写回）。渲染季节/天气时应叠加 `/maps/render`，不要把派生结果写回本地底板缓存。`Space.exposure`（`indoor/outdoor`）是玩家所在格的服务端派生值（§3.5），用于室内外音效/天气表现。

> **查询面（CC-06）**：`/query/*` 全部**只读**（不推进 tick、不改背包/任务、不发事件），实体参数一律 **networkId**。玩家不存在 → 404，房间未就绪 → 503，参数非法 → 400。`reason` 与命令错误码同义（`out_of_range`/`no_item`/`blocked`/`inventory_full`/`locked` 等）；`available` 与真实命令成败一致，`reason` 仅用于提示（例如 `craft` 未解锁时命令回执可能是 `unknown`，以查询的 `available:false` 为准）。商店 `count=-1,unlimited=true` 表示无账本库存的无限货架，`price=null` 表示未定价。查询面当前无鉴权，部署方应限制访问；客户端不要用它替代 `command-result` 的最终裁决。


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

#### 5.2.1 内容目录（`GET /content`）

**目的**：消灭客户端的硬编码静态表——物品/配方/任务/成就/相位/技能的中文名与描述，全部由服务端从**当前 game/ 配置**导出，客户端一次拉取即用。

请求：`GET /content`（无参数、无查询串）。

响应体（JSON）：

```jsonc
{
  "items": [
    {
      "kind": "axe",            // 物品 kind（全局唯一标识）
      "maxStack": 1,            // 单槽最大堆叠数
      "maxDurability": 60,      // 最大耐久
      "toolType": "axe",        // 工具分类
      "consume": [{ "need": "hunger", "amount": 20 }],  // 食用效果
      "equip": { "slot": "tool" },                      // 穿戴效果
      "place": { "archetype": "campfire" },              // 放置效果
      "spoilTicks": 3600,       // 腐烂时长（tick）
      "value": 5,               // 基准价值
      "throw": { "speed": 320, "lifeMs": 1000, … }       // 投掷档案
    }
  ],
  "recipes": [
    {
      "id": "wood_axe",
      "inputs": [["wood", 2]],          // [kind, 数量]
      "outputs": [["axe", 1]],
      "stationType": 0,                 // 站点类型要求（缺省 = 无要求）
      "durationTicks": 0,               // 延时制作时长（缺省 = 瞬时）
      "unlock": { "condition": "inPhase:storm" },  // 解锁条件（可选）
      "desc": "木斧"                    // 描述（配置无描述时用展示名兜底）
    }
  ],
  "quests": [
    { "id": "collect_axe", "state": 0, "count": 0, "title": "带来一把斧头", "desc": "收集 1 个斧头" }
  ],
  "achievements": [
    { "id": "village_friend", "title": "渔村的熟人", "desc": "与渔村势力声望达到 10。", "condition": "factionRepAtLeast:village:10", "reward": { … } }
  ],
  "phases": [
    { "id": "mild", "durationTicks": 24000, "weather": [{ "id": "clear", "weight": 5, "intensity": 0 }], "modifiers": { "temperatureOffset": 0 } }
  ],
  "seasons": [
    { "id": "spring", "durationTicks": 60000 }
  ],
  "skills": [{ "id": "combat", "label": "战斗" }]
}
```

字段说明：

| 段 | 字段 | 说明 |
|----|------|------|
| `items` | `kind` | 物品 kind（与 `Inventory.{i}.kind` / `ItemMeta.kind` 同一命名空间） |
| | 其余字段 | 与物品配置同名同义；**配置未声明的字段直接省略**（不会出现 `null`/空串占位） |
| `recipes` | `inputs`/`outputs` | 归一为 `[kind, 数量]` 数组（二元组） |
| | `unlock` | 解锁条件声明（与服务端裁决同源；客户端可显示提示但**不要**据此禁发命令） |
| `quests` | `state`/`count` | **中性缺省**（0 = 未接 / 进度 0）——内容目录与具体玩家无关；**单个玩家的任务状态以 `Quest.{i}.state/count` 同步为准**（§3.5） |
| | `title`/`desc` | 任务标题/描述（配置无该字段时按展示名/目标形态生成可读兜底文案） |
| `achievements` | `title`/`desc` | 取配置的名称/描述字段（缺省时用展示名/条件兜底） |
| | `condition` | 解锁条件（服务端裁决） |
| `phases` | `id`/`durationTicks`/`weather`/`modifiers` | 环境相位定义（与 `RoomState.phaseId` 同源命名空间）；`weather[].intensity` 为 0..1 强度（缺省 0） |
| `seasons` | `id`/`durationTicks` | 季节循环（与 `RoomState.seasonId` 同源；未配置为空数组） |
| `skills` | `id`/`label` | 技能 id 与展示名（`Progression.skill.{id}` 同源） |

> **展示名兜底链**：配置自带字段（成就的 name/description）→ 服务端登记的展示名（游戏层注册的中文名）→ **配置 id/kind 原文**（如 `wood`、`collect_axe`）。客户端应把 `title`/`label`/`desc` 当作**可直接显示的文本**处理，不要假定其一定是中文或一定是 id。

> **内容随配置漂移**：`/content` 每次请求都按当前 `game/` 配置现算，配置改了即变；客户端**不应缓存到过期**（可按响应体整体缓存，重连时刷新）。


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

1. 声明 §3.4 的 Schema（字段名/类型/顺序严格一致；`EntityState.level` 与 `RoomState` 的四个新字段都在**末尾**）。
2. `joinOrCreate("game")`，记 `room.sessionId`；如需断线复用角色，把自己的 networkId 存本地并在 join 参数回传（§1.3）。
3. 每帧发 `input`（seq 递增，速度不超过 server 规则上限）；按键边沿发 interact/attack/talk。
4. 渲染：遍历自己的 `players.get(room.sessionId).visibleEntities`（唯一实体来源）；按 `EntityState.level` 过滤异层实体。
5. 按 §3.6 辨识实体种类（优先 `Kind.value`），按 §3.5 读字段。
6. UI 操作 → `command`（§2.2），失败以状态回退为准。
7. 用 `/maps/runtime` 拉取地图几何快照，初始化地图渲染与碰撞（出生点不在几何模型，不从地图数据取）。
8. 用 `GET /content` 拉一次内容目录，拿到物品/配方/任务/成就/相位/技能的名称与描述（§5.2.1）——**不要硬编码静态表**。
9. 读 `RoomState.phaseId/phaseProgress/weatherId` 渲染环境 HUD（§3.1）；读 `RoomState.offers` 渲染待处理报价（§3.1「报价摘要」，只有与自己相关的条目）。
10. 对话 UI 读 `Dialogue.text`（正文）与 `Dialogue.option.{i}.text`（选项文案，§4.6）。

---

## 7. 常见问题

| 现象 | 原因 |
|------|------|
| 连接失败/握手无响应 | Schema 与服务端不一致（字段顺序/类型）、地址错误、CORS 白名单未含客户端 Origin |
| 角色不动 | 输入超速被拒（超限帧被丢弃、seq 不推进、无需重发）；或未发 `input`（只发 state 监听） |
| 实体表为空 | 实体恒在自己 `visibleEntities`（首帧后才开始填充）；若持续为空，检查是否同一地图/半径内无实体、或 Schema 声明顺序与服务端不一致 |
| 控制台报 `"refId not found"`、实体字段偶发消失 | 旧基线（core 0.17.x）的上游解码 bug：`visibleEntities` 混入空壳实体，按 §3.2 末尾的兜底规则逐实体过滤即可容忍；当前服务端基线为 0.18.23，客户端仍建议保留兜底 |
| 命令"没反应" | 先看 `command-result` 的 `code`（缺料 `no_item`/满包 `inventory_full`/超距 `out_of_range`/限频 `rate_limited`/冷却 `cooldown` 等）；`unknown` 时再观察状态（§2.3） |
| 投掷"没反应" | 武器槽装备的物品没有投掷档案（服务端要求 `throw` 段）；或服务端冷却未结束（`Cooldown.remainingMs` 已同步但仍以服务端裁决为准，冷却结束前命令会被静默拒收） |
| 报价列表为空 | `RoomState.offers` 只含**与自己相关**的条目（发起方/接收方可见）；或报价已成交/取消（条目移除）。参与方 id 用 **networkId**（自己 `PlayerState.entityId`、对方 `EntityState.id`），不是服务端 eid |
| 中文名显示为英文/原文 | 该条目在配置里没有名称字段且服务端未登记展示名——`/content` 的兜底链末端即 id/kind 原文（§5.2.1） |
| 断线重进后角色变了 | 正常：未命中保留实体（未回传 networkId / 已超保留期）→ 新建角色；命中则复用原角色（§1.3）。服务端重启恢复存档时，未到存档周期的最后变更仍会丢（周期由 server 规则 `saveIntervalMs` 配置） |
| 换图后实体全变 | 正常：该玩家 `PlayerState.mapId` 变化 = 该玩家场景切换，实体集随图切换（玩家自身保留）；其他玩家不受影响 |
| 看不到别的玩家/自己的旧角色 | 处于**断线保留期**的实体不进任何快照（对所有客户端不可见），保留期约 5 分钟后才被清扫 |
