# 服务端对接协议（客户端接入指南）

> 本文档是**独立协议契约**：任何 Colyseus 客户端项目（无论语言/引擎）仅凭本文档即可对接本服务端，
> **无需访问服务端源码**。文档中的消息格式、状态结构、字段语义以文档为准；若部署方明确告知协议有变更，以部署方为准。
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

- 服务端定时持久化（默认 60s）。重启后世界从存档恢复，**玩家实体 NetworkId 保留**：重连后 `PlayerState.entityId` 不变，进度（背包/任务/好感/位置）恢复。
- 断线后实体仍存在（不销毁）；重连进同一房间即复用。

---

## 2. 上行协议（客户端 → 服务端）

两条消息通道，均为 JSON 序列化对象。

### 2.1 逐帧输入 — 消息名 `"input"`

```jsonc
{
  "seq": 1,          // 自增序号（必填）。乱序/重复/小于等于上一条的被丢弃
  "moveX": 0,        // 水平速度分量，像素/秒（必填）
  "moveY": 100,      // 垂直速度分量，像素/秒（必填）
  "interact": false, // 可选：本帧按下"采集"键
  "attack": false,   // 可选：本帧按下"攻击"键
  "talk": false      // 可选：本帧按下"对话"键
}
```

约束：

| 项 | 值 |
|----|----|
| `seq` | 严格递增正整数；被拒输入会回退 seq（客户端需重发） |
| 速度上限 | `|(moveX, moveY)| ≤ 200` 像素/秒，超出整条输入被拒 |
| 意图信号 | `interact` / `attack` / `talk` 为边沿触发（按下那帧置 true 即可，服务端消费后清除） |
| 权威模型 | 服务端权威：客户端**不要**自行预测位移，以状态同步为准 |

### 2.2 离散命令 — 消息名 `"command"`

```jsonc
{ "type": "craft", "recipe": "wood_axe" }
```

命令类型与参数：

| type | 参数 | 语义 |
|------|------|------|
| `consume` | `slot: number` | 食用背包 `slot` 槽物品（恢复生存需求） |
| `drop` | `slot: number` | 丢弃背包 `slot` 槽物品（生成地面掉落物实体） |
| `transfer` | `slot: number`, `toSlot: number` | 背包槽间移动/堆叠 |
| `craft` | `recipe: string` | 合成（配方 id 见 §4.4 清单） |
| `equip` | `slot: number` | 穿戴背包 `slot` 槽物品 |
| `place` | `slot: number`, `x: number`, `y: number` | 放置 kit 物品 → 生成建筑实体（世界坐标） |
| `deconstruct` | `target: number` | 拆除自己放置的建筑（target = 实体 NetworkId） |
| `dialogue` | `option: number` | 推进当前对话（选项索引，见 §4.6） |

约束：

| 项 | 值 |
|----|----|
| 频率上限 | 20 条/秒（滑动窗口），超出被拒 |
| 失败语义 | 任何命令失败（缺料/满包/距离不够/无权拆除等）**无错误回执**，服务端零副作用；客户端以状态变化为准 |
| 命令不进入 `seq` 去重 | 重复发送会被多次执行，客户端自行防抖 |

---

## 3. 下行协议（状态同步）

Colyseus Schema 增量同步（补丁 + 全量握手）。**客户端必须声明与服务端一致的状态结构**，§3.4 给出完整可复制定义。

### 3.1 RoomState（房间根状态）

| 字段 | 类型 | 说明 |
|------|------|------|
| `tick` | uint32 | 逻辑帧号，服务端 20 帧/秒（50ms/帧） |
| `hour` | float64 | 世界小时 0–24（昼夜循环推进） |
| `phase` | uint8 | 0=白天，1=夜晚 |
| `mapId` | string | 当前地图 id（多地图部署时场景切换会变化） |
| `players` | map\<string, PlayerState\> | key = sessionId |
| `entities` | map\<string, EntityState\> | key = NetworkId 字符串。**仅当服务端未开启兴趣裁剪时使用**（见 §3.2） |

### 3.2 PlayerState（每玩家）

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | string | 本连接 sessionId（等于 `room.sessionId`） |
| `entityId` | uint32 | 自己控制的实体 NetworkId（`players.get(room.sessionId).entityId`） |
| `visibleEntities` | map\<string, EntityState\> | **兴趣裁剪开启时**的实体表：key = NetworkId 字符串，只含本玩家视野内实体 |

**兴趣裁剪（重要）**：当服务端配置了视野半径时，实体数据**不会**出现在 `RoomState.entities`，而是进入每个玩家自己的 `visibleEntities`：
- 自己（`entityId` 对应实体）恒在表中；其他实体进入半径（当前部署默认 300px）才出现，离开即被删除。
- 客户端渲染遍历 `state.players.get(room.sessionId).visibleEntities`。
- 该表仅对自己可见（服务端按连接过滤），不要假设能看到其他玩家的表。
- 兼容路径：未开启裁剪的部署中，`visibleEntities` 恒为空，实体走 `RoomState.entities` 全量广播。客户端可两者都监听，取非空者（或按部署方告知的模式）。

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
  @type({ map: EntityState }) visibleEntities = new MapSchema<EntityState>();
}

export class RoomState extends Schema {
  @type("uint32") tick: number = 0;
  @type("float64") hour: number = 8;
  @type("uint8") phase: number = 0;
  @type("string") mapId: string = "";
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: EntityState }) entities = new MapSchema<EntityState>();
}
```

（非 TS/JS 客户端：以本表字段名/类型/顺序为准，用各自语言的 @colyseus/schema 绑定声明。）

### 3.5 同步字段清单（客户端可依赖的 key）

> 以下为当前部署的完整同步集。字段 key 只会有这些；**实体按"拥有哪些组件"决定带哪些 key**（§3.6）。

| 组件 | key 形态 | 语义 |
|------|----------|------|
| Transform | `Transform.x`, `Transform.y` | 世界坐标（像素） |
| Health | `Health.current` | 当前血量（生物） |
| Collider | `Collider.shape`, `Collider.radius` | 碰撞形状：0=圆形 1=矩形 |
| Size | `Size.w`, `Size.h` | 尺寸 |
| Needs | `Needs.{i}.name/current/max` | 生存需求（name ∈ hunger/thirst；任一为 0 持续扣血） |
| Inventory | `Inventory.{i}.kind/count` | 背包槽（容量 12；空槽 kind=`""` 占位） |
| ItemMeta | `ItemMeta.kind/count` | 地面掉落物 |
| ResourceNode | `ResourceNode.remaining` | 资源点剩余量（0 后消失，可再生） |
| Equipment | `Equipment.weaponSlot/toolSlot/armorSlot` | 装备槽引用的**背包槽索引**（-1=空） |
| CraftingStation | `CraftingStation.stationType` | 合成站类型：0=通用手搓，1=火堆 |
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
| `CraftingStation.stationType` + `LightSource.*` | 火堆（合成站） |
| `Portal.targetMap` | 传送门 |
| `Placeable.*` | 建筑 |

---

## 4. 玩法机制（协议映射）

> 数值为当前部署配置；部署方可在配置中调整，客户端不应硬编码判定，仅作 UI 提示参考。

| 玩法 | 操作 | 服务端反应 | 当前关键数值 |
|------|------|-----------|-------------|
| 移动 | `input` moveX/moveY | 速度积分 + 碰撞分离 → `Transform.x/y` 同步 | 速度上限 200px/s |
| 采集 | `input` interact | 半径内最近资源点 → `ResourceNode.remaining` 减少 → 物品入包/落地 | 交互半径 24px |
| 近战攻击 | `input` attack | 半径内最近敌对 → 目标 `Health.current` 减少；击杀掉落地掉落物 | 攻击半径 32px、冷却 1000ms、无友伤 |
| 拾取 | 无操作（走近自动） | 地面物品消失 → `Inventory` 计数增加 | 拾取有防瞬回保护（落地后短暂不可拾） |
| 对话 | `input` talk → `command dialogue` | 见 §4.6 | 对话半径 48px |
| 合成 | `command craft` | 消耗材料 → 产出入包（缺料/满包/站点不符零副作用） | 配方见 §4.4 |
| 装备 | `command equip` | `Equipment` 三槽更新，攻击/采集加成即时生效 | 槽位 weapon/tool/armor |
| 食用/丢弃 | `command consume/drop` | Needs 恢复 / 地面掉物 | 食物恢复 hunger |
| 放置 | `command place` | 校验后消耗 1 个 kit → 生成建筑实体 | 放置距离 64px、网格吸附开启 |
| 拆除 | `command deconstruct` | 仅放置者可拆、范围校验、不返还材料 | — |
| 任务 | 对话选项触发 | 见 §4.7 | — |
| 昼夜 | 被动 | `hour/phase` 每帧同步 | 19–5 点为夜晚 |
| 场景切换 | 走近传送门 | `mapId` 变化、实体集切换（玩家保留） | — |

### 4.1 背包与物品

- 背包 12 槽，`Inventory.{i}.kind` 空槽为 `""`。
- 物品清单（kind）：`wood`、`stone`、`berry`、`raw_meat`、`cooked_meat`、`berry_pie`、`water`、`axe`、`stone_axe`、`spear`、`campfire_kit`、`wall_kit`、`floor_kit`、`door_kit`、`fence_kit`、`furniture_kit`。
- 装备：`axe`/`spear`（weapon 攻击加成）、`stone_axe`（tool 采集倍率）。

### 4.2 生存需求

- `Needs.0` = hunger（饥饿），`Needs.1` = thirst（口渴）。
- 任一需求降到 0 持续扣 `Health.current`；通过 `consume` 食物/水恢复。

### 4.3 敌人

- boar / wolf（夜晚额外刷 wolf）。
- 敌人 AI：感知（视野半径内）→ 追击 → 近战攻击；对光源回避（火堆旁安全）。
- 击杀掉落物经 LootTable 掷骰落地（`ItemMeta` 实体）。

### 4.4 合成配方（recipe id）

| recipe | 消耗 | 产出 | 站点 |
|--------|------|------|------|
| `wood_axe` | wood×2 | axe | 手搓 |
| `stone_axe` | wood×1 stone×1 | stone_axe | 手搓 |
| `spear` | wood×2 stone×1 | spear | 手搓 |
| `berry_pie` | berry×3 | berry_pie | 手搓 |
| `cooked_meat` | raw_meat×1 | cooked_meat | **火堆**（stationType=1） |
| `campfire_kit` | wood×3 stone×2 | campfire_kit | 手搓 |
| `wall_kit` | wood×2 stone×1 | wall_kit | 手搓 |
| `floor_kit` | wood×1 | floor_kit | 手搓 |
| `door_kit` | wood×2 stone×1 | door_kit | 手搓 |
| `fence_kit` | wood×2 | fence_kit | 手搓 |
| `furniture_kit` | wood×2 stone×2 | furniture_kit | 手搓 |

### 4.5 建造

- `place` 生成建筑实体（wall/floor/door/fence/furniture/campfire），网格吸附开启。
- 建筑是静态阻挡（玩家不能穿过墙）；`deconstruct` 仅放置者可拆。
- 建筑实体带 `Placeable.*` / `GridOccupancy.*` key。

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

| 端点 | 说明 |
|------|------|
| `GET /health` | 健康检查，`{"ok":true}` |
| `GET /maps/runtime?mapId=<id>` | 地图运行时数据：网格尺寸、阻挡位图（chunk 化）、内容版本。用于客户端加载地图/碰撞。`mapId` 可选：省略时返回注册表默认地图；未知 id 返回 404，错误体附可用图列表 |
| `GET /maps/meta` | 地图清单：默认图 id 与全部地图的元信息（含 version）。客户端可先拉取清单列出地图、预检版本，再按需拉取 runtime |
| `GET /debug/colliders` | 房间碰撞体调试快照（房间未就绪时 404） |

`/maps/runtime` 返回示例：

```jsonc
{
  "id": "generated-map",
  "name": "…",
  "grid": { "width": 64, "height": 64, "tileWidth": 16, "tileHeight": 16 },
  "version": "a1b2c3d4",          // 内容哈希（uint32 hex）：同内容恒定、内容变化即变；客户端可作缓存键
  "chunks": [                     // 阻挡位图分块：16×16 tile/块，行主序排列
    { "cx": 0, "cy": 0, "data": "…" },   // data：256 字节（每格 1 字节，0=可走 1=阻挡），base64 编码
    { "cx": 1, "cy": 0, "data": "…" }
  ]
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `grid` | 网格尺寸与 tile 尺寸；`width`/`height` 为 tile 数 |
| `version` | 内容哈希（uint32 hex，8 位小写十六进制）。同一地图内容恒定则值恒定，内容变化（如重新生成）则变化。客户端可用 `{id, version}` 作缓存键，跳过重复拉取 |
| `chunks` | 阻挡位图分块数组。每块 16×16 tile（256 字节，每格 1 字节：0=可走 1=阻挡），`data` 为 base64 编码。块按行主序排列：`cx` 为列索引、`cy` 为行索引，总块数 = `ceil(width/16) × ceil(height/16)`。客户端按 `cy` 行、`cx` 列顺序拼接为扁平字节数组（行主序重组） |

`mapId` 参数语义：

- 省略 `mapId`：返回注册表默认地图（即 `/maps/meta` 的 `default` 字段）。
- 未知 `mapId`：返回 404，错误体附可用图列表，例如 `{"error":"unknown map","available":["generated-map","cave"]}`。
- 客户端应在连接后以 `room.state.mapId` 作为请求参数；响应 `id` 与请求不符时告警并拒绝应用（防错图）。

`/maps/meta` 返回示例：

```jsonc
{
  "default": "generated-map",
  "maps": [
    { "id": "generated-map", "name": "…", "kind": "generated", "width": 64, "height": 64, "tileWidth": 16, "tileHeight": 16, "generatorId": "…", "seed": 1, "version": "a1b2c3d4" },
    { "id": "cave", "name": "…", "kind": "generated", "width": 32, "height": 32, "tileWidth": 16, "tileHeight": 16, "generatorId": "…", "seed": 2, "version": "…" }
  ]
}
```

> 用法：客户端可先请求 `/maps/meta` 列出可用地图与各自 `version`（预检版本、渲染地图选择 UI），再按需请求 `/maps/runtime?mapId=<id>` 拉取具体地图数据。

### 5.3 地图内容：生成器 / 校验 / Tiled 制作

> 本节补充地图「如何产生、是否可用、如何手工制作」的服务端视角（§5.2 已讲客户端如何拉取）。地图数据由 `game/maps/registry.json` 声明：`kind: "generated"` 走程序化生成器，`kind: "tiled"` 走外部 Tiled JSON 文件。客户端关注的是最终 `MapRuntime`（网格、阻挡位图、出生点、zone 列表），其规则如下。

#### 5.3.1 内置地图生成器（generatorId）

框架内置两种程序化生成器，生成地图条目通过字段 `generatorId` 选择：

| generatorId | 说明 | 生成规则 |
|-------------|------|----------|
| `simple` | 默认生成器 | 边界一圈全阻挡；内部随机撒约 5% 障碍物；玩家出生在地图中心；单个默认区域。同种子可复现 |
| `cave` | 元胞自动机洞穴 | 内部约 45% 概率初始置墙、边界恒墙；经典 B=r5 / D=r4 规则平滑 5 轮（8 邻域 ≥5 墙则成墙、否则成地面，每轮后边界强制为墙）；玩家出生在最大 4 向连通地面分量的质心最近格（tile 中心）；单个默认区域。同种子可复现 |

两者都基于 xorshift32 伪随机：**相同 `seed` 生成相同地图**。

`kind: "generated"` 条目完整字段示例（`game/maps/registry.json` 的 `maps` 表内）：

```jsonc
{
  "kind": "generated",
  "generatorId": "cave",       // simple | cave（缺省 simple）
  "seed": 2,                   // 随机种子，同种子可复现
  "width": 32,                 // 网格宽（tile 数）
  "height": 32,                // 网格高（tile 数）
  "tileWidth": 16,             // 单格宽（像素）
  "tileHeight": 16,            // 单格高（像素）
  "npcSpawns": [               // 可选：程序生成内置的 NPC 出生点（相对玩家出生点偏移，tile 单位）
    { "kind": "villager", "offsetTiles": [2, 0], "zoneId": 1 }
  ]
}
```

`npcSpawns`（可选）语义：

| 字段 | 类型 | 说明 |
|------|------|------|
| `kind` | string | NPC 类型 id（数据，由配置给出，框架只透传，不硬编码） |
| `offsetTiles` | `[number, number]` | 相对玩家出生点的偏移，单位 tile：`pos = player + offsetTiles × tileSize` |
| `zoneId` | number（可选） | 归属的地图区域 id |

`npcSpawns` 缺省或为空时，该地图不生成任何 NPC 出生点。`generated` 条目其余字段（`width`/`height`/`tileWidth`/`tileHeight`/`seed`）缺省时分别取 64/64/16/16/1。

#### 5.3.2 地图校验（validateMapRuntime）

`buildMapRuntime` 在出口处对**每种来源**（`generated` 与 `tiled`）统一调用 `validateMapRuntime`。校验器是纯函数（不抛错、不记日志），返回 `{ errors, warnings }`；由 `buildMapRuntime` 依 `errors` 抛错、对 `warnings` 逐条 `logger.warn`。

| 级别 | 触发条件 | 表现 |
|------|----------|------|
| 硬错误（HARD ERROR） | 玩家/NPC 出生点落在阻挡格、越出网格边界，或玩家出生点缺失（null） | `buildMapRuntime` 抛出异常 → 该地图**不可用**（构建失败） |
| 软告警（SOFT WARNING） | 最大 4 向连通可走域占全部地面 tile 的比例低于 40%（`MIN_WALKABLE_COMPONENT_FRACTION = 0.4`） | `logger.warn` 记录，**不阻断**构建 |

硬错误常见于出生点被墙/障碍压住、出生点坐标超出地图范围、地图未声明玩家出生点。这类图视为「必坏图」，服务端拒绝构建。软告警的设计意图：洞穴/洞窟类地图天然存在封闭空腔（不可达 ≠ 坏图），因此「连通域占比过低」只告警、不断言地图不可用。

出生点坐标以世界（像素）坐标换算为 tile 坐标后校验（`floor(pos.x / tileWidth)`、`floor(pos.y / tileHeight)`，行主序 `blocked[y * width + x]`），因此「落在阻挡格」与「越界」都拦得住。

影响面：`tools/gen-map`、`tools/export-map` 与 HTTP 端点（`/maps/meta`、`/maps/runtime`）都经 `buildMapRuntime` 构建，因此：

- **硬错误** = 命令非 0 退出 / 端点返回错误（该图无法产出运行时数据）；
- **软告警** = 命令照常成功，日志出现该图的连通性警告。

客户端效应：一个「必坏图」不会出现在可用的运行时数据里（`/maps/runtime` 对其直接返回错误而非 200 + 数据），客户端按拉图失败处理即可；正常地图恒可成功构建。

#### 5.3.3 Tiled 地图制作与注册

若需手工制作静态地图，用 [Tiled](https://www.mapeditor.org/) 编辑器绘制后导出为 JSON，再经服务端解析。依赖**固定图层名**，解析约定如下：

| 图层 | 类型 | 约定 |
|------|------|------|
| `collision` | tilelayer | 阻挡层：非 0 的 tile 视为阻挡（0=可走，1=阻挡） |
| `zones` | objectgroup | 区域：`type="zone"` 的对象，带 `zoneId` 属性；有 `polygon` 用多边形顶点，否则兜底为矩形（`x/y/width/height` 围成） |
| `objects` | objectgroup | 出生点：`type="spawn_player"` / `type="spawn_npc"`；NPC 的 `kind` 由 `npcKind` 属性给出，`zoneId` 属性可选 |

根字段：`width` / `height`（tile 数）、`tilewidth` / `tileheight`（单格像素）。对象坐标均为 Tiled 的像素世界坐标（原点左上角）。

注册步骤：

1. 把 Tiled 导出的 JSON 保存到 `game/maps/`（如 `tiled-demo.json`）。
2. 在 `game/maps/registry.json` 中加入 `kind: "tiled"` 条目，`path` 指向该 JSON，并配所需的 `mapId`；之后用 `mapId` 引用它（`/maps/runtime?mapId=<id>`、`room.state.mapId`、传送门 `targetMap` 等）。

```jsonc
{
  "maps": {
    "tiled-demo": {
      "kind": "tiled",
      "path": "game/maps/tiled-demo.json",
      "name": "手作示例地图"
    }
  }
}
```

> 示例：`game/maps/tiled-demo.json` 是一张手工绘制的示例图，注册为 mapId `tiled-demo`（由独立任务产出，此处不列举其具体内容）。`kind: "tiled"` 条目经 `buildMapRuntime` 构建后同样接受 §5.3.2 的校验。

---

## 6. 对接清单（Checklist）

1. 声明 §3.4 的 Schema（字段名/类型/顺序严格一致）。
2. `joinOrCreate("game")`，记 `room.sessionId`。
3. 每帧发 `input`（seq 递增，速度 ≤ 200）；按键边沿发 interact/attack/talk。
4. 渲染：遍历自己的 `visibleEntities`（或 `entities`，视部署是否开裁剪）。
5. 按 §3.6 辨识实体种类，按 §3.5 读字段。
6. UI 操作 → `command`（§2.2），失败以状态回退为准。
7. 用 `/maps/runtime` 初始化地图与出生点。

---

## 7. 常见问题

| 现象 | 原因 |
|------|------|
| 连接失败/握手无响应 | Schema 与服务端不一致（字段顺序/类型）、地址错误、CORS 白名单未含客户端 Origin |
| 角色不动 | 输入超速被拒（回退 seq 需重发）；或未发 `input`（只发 state 监听） |
| 实体表为空 | 未开兴趣裁剪时实体在 `state.entities`；开了则在自己 `visibleEntities`（首帧后才有） |
| 命令"没反应" | 命令失败无回执：缺料/满包/频率超限/距离不够，观察状态确认 |
| 断线重进后实体变了 | 服务端重启恢复存档，未到存档周期的最后几分钟进度会丢（60s 周期内） |
| 换图后实体全变 | 正常：`mapId` 变化 = 场景切换，实体集随图切换（玩家自身保留） |
