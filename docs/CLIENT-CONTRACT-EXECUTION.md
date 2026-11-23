# 客户端消费面补齐执行文档（Client Contract Execution Plan）

> 状态：待执行  
> 适用仓库：`game_server_test`（服务端）；关联仓库：`godot-client`（Godot 4.7 客户端）  
> 读者：执行本计划的 AI agent / 开发者  
> 自包含说明：本文不依赖任何会话上下文。执行前先读 §0、§3、§4；所有路径均相对 `game_server_test/`，另有标注的除外。  
> 关联文档：`AGENTS.md`、`docs/architecture.md`、`docs/CLIENT-INTEGRATION.md`、`docs/MINIMAL-CLIENT-SPEC.md`、`docs/ROADMAP.md`。

---

## 0. 快速上下文（执行前必读）

### 0.1 项目是什么

`game_server_test` 是一套**配置驱动的 2D 游戏服务端**：

- Node.js ≥ 22 + TypeScript + bitecs 0.4（ECS）+ Colyseus（WebSocket 状态同步）。
- 服务端权威：客户端只发输入/命令，服务端裁决一切状态。
- 游戏内容在 `game/` 下的 JSON：实体原型、行为树、地图、规则、物品、对话、任务。
- 框架在 `framework/`，必须**游戏无关**；游戏专属语义只能出现在 `game/` 或 `src/register.ts`。
- 地图由 `framework/map/` 的生成积木产出 `MapGeometry`（地面语义/通行/层号/区域），地上的树、石头、房子、门等是实体。
- 网络层在 `framework/net/`，每 tick 把 ECS 状态派生为 Colyseus `RoomState`，经 per-client `PlayerState.visibleEntities` 同步。
- 持久化是文件仓储（`data/saves/`），不是数据库。

`godot-client` 是 Godot 4.7 空壳客户端，已有 `addons/colyseus`（0.18.9）和 `Main.gd` 脚手架，但没有场景/美术/动画。目标是让它**只消费服务端数据**就能做可视化，而不是把服务端的规则再抄一遍。

### 0.2 常用命令

```bash
cd game_server_test
pnpm install
pnpm dev                 # tsx 热重载，默认端口 3000
pnpm build               # tsc + tsc-alias
pnpm test                # vitest
pnpm tools validate      # 校验 game/ 配置
pnpm schema:check        # 校验客户端 schema 副本与 codegen 一致
pnpm schema:gen          # 重新生成客户端 schema 副本
```

### 0.3 当前版本基线（以此为准，不要照抄旧文档）

- `@colyseus/core`：**0.18.23**（`package.json` / `pnpm-lock.yaml`）
- `@colyseus/schema`：**5.0.43**
- Godot Colyseus addon：**0.18.9**（`godot-client/addons/colyseus/version.json`）
- 服务端 tickRate：当前游戏配置 **20 tps**（`game/game.json`）
- `docs/CLIENT-INTEGRATION.md` / `docs/MINIMAL-CLIENT-SPEC.md` 里仍写着 0.17.43 / schema 4.0.25，属于**过时基线**；执行本计划时顺手修正或标注。

### 0.4 关键术语

| 术语 | 含义 |
|---|---|
| `eid` | bitecs 内部实体 id，会复用，**不能发给客户端** |
| `networkId` | 实体对外的稳定 id（`NetworkId` 组件），客户端只用它 |
| `MapGeometry` | 地图底板：`tiles`（地面语义 id）、`walkable`、`level`、`regions`、`regionOfTile`、`version` |
| `EffectiveGround` | 底板语义经相位/天气/覆盖规则派生出的“有效地面”，查询期计算，不写回 |
| `netSync` | `game.json` 里声明哪些组件字段进入 `EntityState.values/stringValues` 的白名单 |
| `visibleEntities` | 每个玩家自己的兴趣裁剪实体表，按同图 + 同层 + 视野半径裁剪 |
| `runtimeEvents` | 帧内轻量事件队列，帧首清空，只服务内部系统 |
| `eventBus` | 类型化帧内事件队列，由 `triggerSystem` 整体 drain，只服务内部系统 |
| `Client Contract` | 本文要补的“客户端消费契约层”：表现清单、动作时间轴、事件流、地图视图、查询面、版本 |

---

## 1. 问题陈述

服务端现在是一套**无头仿真内核 + 调试快照协议**，不是“给游戏客户端消费的会话协议”。

机制层并不弱：战斗、采集、建造、任务、对话、天气、灾害、存档、兴趣裁剪都有。但客户端需要的以下信息没有稳定出口：

1. **表现语义**：地图 id、图块语义 id、实体 kind、物品 kind 没有“名字/贴图/动画/音效”的映射；客户端只能硬编码。
2. **动作过程**：攻击/采集/放置/拆除/对话/换图都在同一 tick 瞬时完成，没有动作开始 tick、时长、阶段、目标、朝向；客户端只能看到结果。
3. **表现事件**：`on-hit`、`on-death`、`on-item-break`、`on-achievement`、`on-raid-warning` 等内部事件不出网；客户端只能靠状态 diff 猜。
4. **地图运行时视图**：`/maps/runtime` 每次全量 JSON `number[]`；有效地面、碰撞、室内/LOS、逐层几何、地图增量都不下发。
5. **查询与回执**：交互/放置/合成/商店/任务没有查询面；命令失败无错误码，客户端“点了没反应”。
6. **版本与工具链**：`/content` 无版本/ETag；文档、package、Godot addon 版本漂移；客户端 schema 手抄，字段顺序即线协议，却没有握手。

现有 HTML 客户端（`assets/html/index.html`）已经用硬编码绕过了这些：HP 上限写死、移动速度写死 32px/s、积雪按相位权重近似、天数本地累计、配方解锁只做提示。Godot 一旦上真实美术/动画/UI，这些债会全部暴露。

**本计划的目标不是重写服务端，而是补一层 Client Contract，并把已有但未接线的能力接出来。**

---

## 2. 目标与非目标

### 2.1 目标

- Godot 客户端能仅凭服务端数据完成：地图渲染、实体表现、动作动画、战斗/采集/制作反馈、背包/任务/成就/商店 UI、放置预览、换图/重生过渡。
- 服务端仍然是唯一权威：客户端只发输入/命令/只读查询，不写状态。
- `framework/` 保持游戏无关；游戏专属的名称、贴图引用、动作参数放 `game/` 或 `src/register.ts`。
- 所有协议变更**可发现、可版本化、可测试**；旧客户端不会静默解码错位。

### 2.2 非目标

- 不在本计划内制作 Godot 场景/美术资源/动画帧。
- 不要求实现客户端预测；但必须提供预测所需的数据（serverTime、input ack、碰撞快照），是否用由客户端决定。
- 不重写 ECS、不替换 Colyseus、不引入数据库。
- 不在 P0 做账号/匹配/多世界；这些放 P2。
- 不把游戏逻辑写进 `framework/`，也不把表现资源路径写进 `framework/`。

---

## 3. 硬约束（违反即返工）

1. **读 `AGENTS.md` 的“AI 协作铁律”**：`framework/` 下不得出现游戏专属语义（hunger/wood/villager 等）；通用机制进 framework，具体内容进 `game/` 或 `src/register.ts`。
2. **协议只做加法**：`RoomState` / `PlayerState` / `EntityState` 的新字段一律**追加在末尾**；已有字段索引不变。破坏性变更必须提升 `protocolVersion` 并同步文档/客户端。
3. **客户端 schema 必须同步**：改 `framework/net/colyseus/state/*.ts` 后跑 `pnpm schema:gen` 并提交 `src/network/colyseus/client-schema/schema.ts`；`pnpm schema:check` 必须绿。
4. **客户端只认 networkId**：任何对外字段、查询参数、事件载荷不得暴露 eid。
5. **per-client 过滤**：涉及隐私/兴趣的数据必须按客户端过滤；不能把别人的背包、对话、任务、事件广播出去。
6. **新增端点必须有测试**：正常路径、未知 id、空数据、权限/隐私、版本缓存。
7. **保持基线绿**：每个阶段结束跑 `pnpm test && pnpm build && pnpm tools validate && pnpm schema:check`。
8. **不要绕过已有原子**：查询/命令必须复用 `combatSystem`、`placeableSystem`、`craftRecipe`、`dialogueSystem`、`questSystem` 等现有校验函数，禁止在 HTTP 层复制规则。
9. **无新依赖**，除非确有必要并在文档中说明。

---

## 4. 现状基线（执行前核对）

### 4.1 关键文件索引

| 文件 | 作用 |
|---|---|
| `framework/net/colyseus/rooms/GameRoom.ts` | 传输层胶水：收 input/command，驱动 `sim.tick`，写 `RoomState`，per-client `visibleEntities`，目前只发 debug 消息 |
| `framework/simulation/GameSimulation.ts` | `SimulationPort` 实现：输入/命令、快照、兴趣、存档、离线补差 |
| `framework/simulation/SimulationPort.ts` | 传输层与仿真层接口 |
| `framework/simulation/types.ts` | `PlayerInput`、`PlayerCommand`、`TickSnapshot`、`TickResult` 等 DTO |
| `framework/simulation/interest.ts` | 同图 + 同层 + 半径裁剪 |
| `framework/simulation/inputValidation.ts` | 移动速度上限、命令频率限流 |
| `framework/net/colyseus/state/{RoomState,PlayerState,EntityState}.ts` | Colyseus schema（字段顺序即线协议） |
| `src/network/colyseus/client-schema/schema.ts` | 客户端 schema 手抄副本（codegen 产物） |
| `tools/schemaCheck.ts` | schema codegen 一致性校验（当前只生成 `--ts`） |
| `framework/net/colyseus/server.ts` | HTTP 端点：`/health`、`/content`、`/maps/runtime`、`/maps/meta`、`/debug/colliders` |
| `framework/content/catalog.ts` | `/content` 六段：items/recipes/quests/achievements/phases/skills |
| `framework/content/labels.ts` | 展示名注册表（中文硬编码在 `src/register.ts`） |
| `framework/map/geometry/types.ts` | `MapGeometry` 定义 |
| `framework/map/geometry/snapshot.ts` | 地图 JSON 快照序列化 |
| `framework/map/geometry/delta.ts` | 地形写回增量（当前只用于存档） |
| `framework/map/runtime/terrainWriteback.ts` | 地形写回入口 + 脏格登记 |
| `framework/map/runtime/indoors.ts` | 室内/露天派生查询（当前不下发） |
| `framework/simulation/events/eventBus.ts` | 类型化帧内事件总线 |
| `framework/events/gameEvents.ts` | `killed` 等轻量帧内事件 |
| `game/game.json` | 游戏入口 + `netSync.fields` 白名单 |
| `game/rules/*.json` | 战斗/合成/需求/环境/灾害/袭击等规则 |
| `docs/CLIENT-INTEGRATION.md` | 现有客户端协议文档（面向 HTML demo） |
| `docs/MINIMAL-CLIENT-SPEC.md` | 最小 Web 客户端生成规格 |
| `godot-client/addons/colyseus/colyseus.gd` | Godot SDK 包装（0.18.9） |
| `godot-client/Main.gd` | 现有连接脚手架（端口 3099，与服务端 3000 不一致） |

### 4.2 当前 `netSync`（`game/game.json`）

已同步：

- `Transform.x/y`
- `Kind.value`
- `Health.current`
- `Collider.shape/radius`
- `Size.w/h`
- `Needs.{i}.name/current/max`（Player）
- `Inventory.{i}.kind/count/durability`（Player/Container）
- `ItemMeta.kind/count/durability`（Item）
- `ResourceNode.remaining`（Resource）
- `Equipment.weaponSlot/toolSlot/armorSlot`
- `CraftingStation.stationType`
- `LightSource.radius/fuelRemainingMs`
- `Placeable.footprintW/footprintH/canCollide`
- `Structure.role/connectLow/connectHigh/connectDir`
- `Passage.open`
- `GridOccupancy.cellX/cellY/cellW/cellH`
- `Portal.targetMap/x/y`
- `Dialogue.npcId/treeId/nodeId/text/optionText/options`（Player）
- `DialogueSource.treeId`（NPC）
- `Quest.{i}.questId/state/count`（Player）
- `Relation.{i}.npcKind/value`（Player）
- `Progression.totalXp/level/skills`（Player）
- `Achievements.{id}`（Player）
- `Crafting.{i}.recipeId/remainingTicks/progress/suspended`（Player）
- `Cooldown.remainingMs`（Player）

### 4.3 当前已知问题（执行时要顺手修或明确不修）

| 问题 | 位置 | 影响 |
|---|---|---|
| `latest-wins` 输入覆盖 | `GameSimulation.latestInputBySessionId` | 客户端 >20Hz 发 input 时，后一条 `interact:false` 会覆盖前一条 `interact:true`，按键丢 |
| 命令失败无回执 | `GameRoom` 丢弃 `submitCommand` 返回值；`PlayerCommand` 无 requestId | UI 无法提示失败原因 |
| 无鉴权 + networkId 可冒领 | `GameRoom.onJoin` 只按 `networkId` 匹配保留实体 | 保留期内任何客户端可接管他人角色 |
| WebSocket 默认 maxPayload 偏小 | `WebSocketTransport` 默认配置 | 较大的 `offer`/命令可能被传输层静默丢 |
| 命令白名单三处硬编码 | `GameRoom.isPlayerCommand`、`PlayerCommand` 类型、`GameSimulation.submitCommand` | 加命令要改三处，客户端易漏 |
| 地图全量 JSON | `/maps/runtime` | 192×192 四个数组 ~14.7 万个数，每次写回全量重拉 |
| 地图写回无推送 | `terrainWriteback` 脏格已登记，无消费者 | 客户端只能轮询 `/maps/meta` |
| `debug_colliders` 用 eid | `GameRoom.getCollisionDebugSnapshot` / `server.ts` | 调试渲染无法与 `EntityState.id` 关联 |
| 制作 key 用数组下标 | `GameSimulation.writeCraftingProjection` | 完成一条后后续 key 平移，客户端 UI 跳 |
| 文档版本漂移 | `CLIENT-INTEGRATION.md` / `MINIMAL-CLIENT-SPEC.md` | 写 0.17/4.0.25，实际 0.18/5.0.43 |
| Godot 脚手架端口 | `godot-client/Main.gd` | 3099 vs 服务端 3000 |
| `Kind` 文档矛盾 | `MINIMAL-CLIENT-SPEC.md` 说不同步，实际 `game.json` 同步 | 客户端按文档写会误判 |

---

## 5. 缺口总表

| ID | 模块 | 解决什么问题 | 优先级 |
|---|---|---|---|
| CC-01 | Client Manifest（含协议/内容/schema 版本） | 客户端不再硬编码静态表；版本可协商 | P0 |
| CC-02 | 地图/图块语义表 | `mapId`、`tile id`、`levelSemantics` 有名字和表现引用 | P0 |
| CC-03 | Action Timeline + ActionState | 动作开始/时长/阶段/目标/朝向；动画与伤害对齐 | P0 |
| CC-04 | Client Event Outbox + Command Result | 伤害/死亡/制作/任务/成就/灾害等表现事件；失败有错误码 | P0 |
| CC-05 | Map Client View | 地图 delta、有效地面、碰撞/占用、室内/LOS、逐层可见性 | P0 |
| CC-06 | Query / Affordance | 交互候选、放置预览、合成/商店/任务查询 | P0 |
| CC-07 | State Sync Completion | 补血条、走/停、燃烧、状态、归属、腐烂、商店库存等字段 | P0 |
| CC-08 | Protocol / Schema 工具链 | 版本握手、GDScript codegen、文档基线修正 | P0 |
| CC-09 | UI Data Projection | 任务全定义/奖励、成就进度、技能曲线、商店实价、势力/伤害类型 | P1 |
| CC-10 | Player Profile | 名字、角色、外观、他人装备 | P1 |
| CC-11 | Audio / VFX | 音效/粒子/打击反馈的事件与资源清单 | P1 |
| CC-12 | Weather / Season View | 天数、季节、温度、天气强度、切换事件、季节地面 | P1 |
| CC-13 | Map Decoration / World Map | Tiled tileset/装饰层、autotile mask、地图连接/POI | P1 |
| CC-14 | Network Feel | serverTime、input ack、固定步长、重连、预测支持 | P1 |
| CC-15 | Session / Auth / Rooms | 鉴权、角色、房间/匹配、多世界 | P2 |
| CC-16 | Content Distribution / i18n | manifest 分发、locale key、资源包 | P2 |
| CC-17 | Telemetry / Replay / Debug | 回放、AI 路径/仇恨可视化、指标 | P2 |

---

## 6. P0 执行计划

> 执行方式：按 CC-01 → CC-08 顺序推进；CC-03/04/05 可并行，但必须先定协议形状再写实现。每个 CC 完成后单独提交，附测试与文档更新。

### CC-01 Client Manifest

**目标**：一个带版本的静态契约端点，客户端一次拉取即可知道“这个游戏有哪些地图/实体/图块/物品/动画/音频/规则”。

**交付物**

- `GET /client/manifest`，响应 `ClientManifest`。
- `ClientManifest` 至少包含：

```jsonc
{
  "protocolVersion": 1,
  "schemaVersion": "5.0.43",
  "contentVersion": "fnv1a32-hex",
  "tickRate": 20,
  "world": { "tileWidth": 16, "tileHeight": 16, "storyHeight": 24 },
  "serverRules": {
    "viewRadius": 304,
    "maxMoveSpeed": 32,
    "maxCommandsPerSec": 20,
    "offlineRetentionTicks": 6000,
    "placeRange": 64,
    "talkRange": 48,
    "containerRange": 64,
    "stationRange": 64
  },
  "netSync": [
    { "component": "Transform", "fields": ["x", "y"], "tags": [] }
  ],
  "maps": [
    {
      "id": "island",
      "displayName": "荒岛",
      "sceneId": "island",
      "tilesetId": "spring",
      "ambientId": "island_day",
      "musicId": "island_bgm",
      "minimap": { "color": "#3a6b4a", "icon": "island" },
      "connections": [
        { "to": "swamp", "kind": "portal", "x": 140, "y": 166 }
      ],
      "tileSemantics": { "1": { "name": "deep_ocean", "category": "water", "walkable": false } },
      "levelSemantics": { "slope": 7, "cliff": 8 }
    }
  ],
  "entities": [
    {
      "kind": "tree",
      "displayName": "树",
      "category": "resource",
      "tags": ["Resource"],
      "size": { "w": 16, "h": 16 },
      "anchor": { "x": 0.5, "y": 1 },
      "visualId": "tree",
      "animationSetId": "tree",
      "audioSetId": "tree",
      "shadow": true
    }
  ],
  "tileSemantics": {
    "1": { "name": "deep_ocean", "category": "water", "walkable": false, "autotileGroup": "water", "footstepId": "water" }
  },
  "items": [],
  "animations": {},
  "audio": {},
  "statusEffects": [],
  "damageTypes": [],
  "factions": [],
  "stationTypes": []
}
```

> `storyHeight` 是示例值：当前 `game.json` 没有该字段。执行 CC-01 时要么在 `game.json` 增加 `world.storyHeight`，要么从 manifest 中移除；不要保留一个没有配置来源的魔法数。

**任务**

1. 新增 `framework/content/manifest.ts`：类型 + `buildClientManifest(gameDef, options)` 纯函数。
2. 新增通用表现注册表（框架侧只存 opaque id，不解释含义）：
   - `framework/content/presentation.ts`：`registerEntityPresentation(kind, spec)`、`registerTileSemantic(mapId | "*", id, spec)`、`registerMapPresentation(mapId, spec)`、`registerAnimationSet(id, spec)`、`registerAudioSet(id, spec)`。
   - 游戏侧在 `src/register.ts` 或新 `game/presentation/*.json` 填充当前内容。
3. `server.ts` 挂 `GET /client/manifest`，支持 `ETag` / `If-None-Match` / `Cache-Control: no-cache`。
4. `contentVersion` 用 game 配置 + 表现注册表的稳定 hash（可复用 `fnv1a32` 思路）。
5. 测试：空配置、完整配置、ETag 命中/未命中、未知内容不崩溃。

**验收**

- Manifest 覆盖所有已配置地图、实体 kind、物品、tile 语义（含 1..12、焦土 9、季节 10/11/12）。
- `contentVersion` 在配置/表现变更时变化，未变更时稳定。
- `pnpm tools validate` 能检查“地图用到的 tile id 是否有语义”。
- `framework/` 不出现具体游戏名词；游戏内容由 `game/`/`src/` 注册。

**不要做**

- 不要把贴图路径/图集坐标写进 `framework/`；只给 `visualId`/`animationSetId`/`audioSetId`。
- 不要删除 `/content`；它保留给旧客户端。

---

### CC-02 地图/图块语义表

**目标**：解决 `mapId` 和 `tile id` 的“无名字、无表现、跨图冲突”。

**交付物**

- `game/presentation/maps.json`（或等价配置）：
  - 每张图：`displayName`、`sceneId`、`tilesetId`、`ambientId`、`musicId`、`minimap`、`connections`。
  - 全局 `tileSemantics`：id → `{ name, category, walkable, autotileGroup, footstepId, minimapColor }`。
  - 每图 `tileSemanticsOverride`：解决同一个 id 在不同图含义不同（例如 island 的 1 = 深水，cave/ruins 的 1 = 墙）。
  - `levelSemantics`：slope/cliff 的 id。
- 校验：`pnpm tools validate` 检查每张图实际出现的 tile id 都有语义（含 `environment.groundOverrides` 的 `toSemantic`、`disasters` 的 `scorchGround`）。
- Manifest 的 `maps[]` 引用这些数据。

**任务**

1. 定义 zod schema（`framework/config/schema/PresentationSchema.ts` 或 `framework/content` 内）。
2. 为 `island/cave/swamp/ruins/highlands/island-v2/tiled-demo/building-demo` 填语义。
3. 在 `loadGameDefinition` 或 `tools validate` 加“tile 语义完整性”检查。
4. 测试：缺失语义时报错；环境覆盖 id 也有语义；跨图 override 生效。

**验收**

- 客户端不再需要 `game/maps/*-palette.json` 也能知道每个 tile 画什么。
- 同一个 id 在不同图有不同语义时，manifest 明确。
- `levelSemantics` 的 slope/cliff id 有名字和规则说明（可通行/单向跳下）。

---

### CC-03 Action Timeline + ActionState

**目标**：把“瞬时动作”改成“服务端权威的动作过程”，让客户端能按 `startTick + durationTicks + phase` 播放动画，并让伤害/采集在正确的阶段结算。

**第一切片范围**：`attack`、`gather`、`throw`。`place/deconstruct/consume/dialogue` 可后续接入。

**交付物**

1. 配置 schema（`framework/config/schema/ActionSchema.ts`）：

```jsonc
{
  "actions": {
    "attack": {
      "durationTicks": 12,
      "phases": [
        { "id": "windup", "endTick": 4 },
        { "id": "active", "endTick": 7 },
        { "id": "recovery", "endTick": 12 }
      ],
      "events": [{ "phase": "active", "type": "hit" }],
      "lockMovement": true,
      "interruptible": false
    },
    "gather": {
      "durationTicks": 10,
      "phases": [{ "id": "swing", "endTick": 6 }, { "id": "recovery", "endTick": 10 }],
      "events": [{ "phase": "swing", "type": "harvest" }],
      "lockMovement": true,
      "interruptible": false
    },
    "throw": {
      "durationTicks": 8,
      "phases": [{ "id": "windup", "endTick": 4 }, { "id": "release", "endTick": 5 }, { "id": "recovery", "endTick": 8 }],
      "events": [{ "phase": "release", "type": "spawn-projectile" }],
      "lockMovement": true,
      "interruptible": false
    }
  }
}
```

2. `game/rules/actions.json`（或 `game/actions/*.json`），游戏层提供具体参数；无配置时保持旧瞬时行为（测试兼容）。
3. 新组件 `ActionState`（AoS，参考 `StateMachine`/`Modifiers` 的数组模式）：
   - `actionId: string`
   - `startedTick: number`
   - `durationTicks: number`
   - `phase: string`
   - `targetNetworkId?: number`
   - `dirX: number` / `dirY: number`
   - `locked: boolean`
   - `interruptible: boolean`
4. 新系统 `actionSystem`（或扩展现有系统）：
   - 输入开始时写 `ActionState`，不立刻结算。
   - 每 tick 推进 phase；在事件阶段调用对应原子（`attackTarget` / `harvest` / `throwWeapon`）。
   - 结束/取消清空。
   - 死亡/换图/受击可打断（按配置）。
5. `PlayerInput` 增加可选 `target?: number`（networkId）或 `aimX/aimY`；未提供时保留“选最近目标”，但必须把 resolved target 写入 `ActionState`。
6. netSync（追加，不改旧 key）：`Action.actionId`、`Action.startedTick`、`Action.durationTicks`、`Action.phase`、`Action.target`、`Action.dirX`、`Action.dirY`。
7. 事件：`action-start`、`action-phase`、`action-hit`、`action-end`、`action-cancel`（走 CC-04 的客户端事件流）。
8. 测试：
   - 攻击在 active 阶段才扣血；windup 期间目标死亡/离开则取消或落空。
   - 采集在 swing 阶段才扣 `ResourceNode.remaining`；采集有冷却，不能每 tick 触发。
   - 投掷在 release 阶段生成投射物。
   - 移动锁/打断/换图清理。
   - 无 `actions.json` 时旧行为不变。

**验收**

- 客户端可以用 `RoomState.tick` 与 `Action.startedTick/durationTicks` 算动画进度。
- 攻击有明确的 `target` 和 `dir`，客户端能朝向/命中特效。
- 采集不再每 tick 触发。
- 测试全绿。

**不要做**

- 不要把动作名/时长硬编码进 framework；全部走配置注册表。
- 不要让客户端决定命中/伤害；服务端仍在 active 阶段裁决。
- 不要一次性改所有动作；先 attack/gather/throw，其余保持旧路径。

---

### CC-04 Client Event Outbox + Command Result

**目标**：把内部事件变成 per-client、可去重、可过滤的表现事件；命令失败有错误码。

**交付物**

1. `framework/simulation/clientEvents.ts`：
   - `ClientEvent { seq, tick, type, data }`
   - `emitClientEvent(world, type, data, audience)`；`audience` 支持 `self` / `nearby` / `map` / `world`。
   - 每 tick 收集到 `TickResult.events`（或 `GameSimulation` 内部 outbox）。
   - 事件按客户端过滤：地图、兴趣、隐私（例如别人的背包变化不发给旁观者）。
2. `GameRoom` 每 tick 批量发送：
   - `client.send("events", { events: [...] })`；或 `client.send("event", event)` 逐条。优先批量，减少消息数。
   - 客户端按 `seq` 去重；`seq` 每客户端单调递增。
3. 事件类型（第一批）：
   - `action-start` / `action-phase` / `action-hit` / `action-end` / `action-cancel`
   - `hit`（damage/crit/damageType/target）
   - `death` / `respawn`
   - `gather`（node/target/items）
   - `craft-start` / `craft-progress` / `craft-complete` / `craft-cancel`
   - `item-break`
   - `quest-update` / `quest-complete`
   - `achievement`
   - `level-up`
   - `raid-warning`
   - `weather-change`
   - `terrain-writeback`
   - `map-change`
4. 命令回执：
   - `PlayerCommand` 增加 `requestId?: string`。
   - `GameSimulation.submitCommand` 返回 `CommandResult { ok, code, data? }`。
   - `GameRoom` 回 `command-result { requestId, type, ok, code, data }`。
   - 错误码统一：`invalid`、`no_item`、`inventory_full`、`out_of_range`、`cooldown`、`rate_limited`、`dead`、`not_owner`、`blocked`、`unknown`。
5. 测试：
   - 两个客户端，A 的攻击事件只发 A 和附近玩家；B 的背包变化不发 A。
   - `seq` 单调；批量事件顺序稳定。
   - 命令失败返回对应 code；成功也回执。
   - 无事件时不下发空包（或只发空数组，二选一，文档固定）。

**验收**

- 伤害数字/命中/死亡/制作完成/任务/成就/袭击预警都有事件。
- 命令失败有错误码，客户端可提示。
- 事件不会跨客户端泄漏。

**不要做**

- 不要把 eid 放进事件载荷；用 networkId。
- 不要每条事件单独广播给全房间；按 audience 过滤。
- 不要让事件流成为第二套权威状态；事件是通知，状态仍以 `RoomState` 为准。

---

### CC-05 Map Client View

**目标**：客户端能只拉一次底板，之后按版本/脏格增量更新；能拿到当前有效地面、静态碰撞/占用、室内/露天、地图图。

**交付物**

1. **地图版本同步**
   - `PlayerState.mapVersion: string`（追加字段）或 `PlayerState.mapVersion` + `mapId`。
   - `GameRoom` 每 tick 写入 `snapshot.playerMaps` 对应的 `geometry.version`（玩家当前图）。
   - 客户端检测到 `mapVersion` 变化时拉增量。

2. **地图增量**
   - `GET /maps/runtime?mapId=<key>&sinceVersion=<version>`：
     - `sinceVersion` 为空：返回全量（保持旧行为）。
     - `sinceVersion` 等于当前：`{ key, version, unchanged: true }`。
     - 否则：`{ key, version, baseVersion, modifications: [{ tileIndex, field, value }] }`，复用 `framework/map/geometry/delta.ts` 的 `computeTileModifications`（需要保留出厂底板/基线）或读 `terrainWriteback` 脏格。
   - 保留无 `sinceVersion` 的旧响应形状，避免破坏 HTML 客户端。

3. **有效地面**
   - `GET /maps/render?mapId=<key>`：返回 `{ key, baseVersion, renderVersion, phaseId, phaseProgress, tiles: number[] }`，`tiles` 是 `effectiveGroundAt` 逐格结果。
   - `renderVersion` = hash(baseVersion, phaseId, phaseProgress 量化, tiles)；客户端按此缓存。
   - 如果性能不允许逐格，改为返回稀疏 `{ tileIndex, semantic }[]`；在文档中固定。
   - 说明：不要让客户端自己实现 `groundCoverageHash`，除非同时下发完整算法规格；P0 由服务端算。

4. **静态碰撞/占用**
   - `GET /maps/collision?mapId=<key>&level=<n>`：返回静态碰撞体/阻挡格，包含地形 + 建造物（`walkableAtLevel` 结果），实体用 networkId 引用。
   - 复用 `getCollisionDebugSnapshot` 的内部数据，但输出正式形状（不是 debug）。
   - 用于放置预览/客户端碰撞镜像/遮挡。

5. **室内/露天**
   - `EntityState` 增加 `exposure`（`"indoor" | "outdoor"`）或 `values["Space.exposure"]`；每 tick 对玩家/可交互实体用 `spaceExposureAt` 写入。
   - 或在 `/maps/collision` 里返回室内格位图；二选一，优先 per-entity（成本低）。

6. **地图图/世界图**
   - `GET /world/map-graph`：`{ maps: [{ id, displayName, connections: [{to, kind, x, y}] }] }`。
   - POI 可后续加；P0 先给地图连接。

7. 测试：
   - `sinceVersion` 全量/未变/增量三条路径。
   - 写回一格后增量只含该格。
   - `render` 的有效地面与 `effectiveGroundAt` 一致（抽格比对）。
   - 碰撞包含放置的墙/地板。
   - `exposure` 在进入/离开房间后变化。

**验收**

- Godot 能按 `mapVersion` 增量更新 TileMapLayer，不再整图重拉。
- 季节/天气地面与服务器一致。
- 放置预览/碰撞镜像有官方数据源。

**不要做**

- 不要删除 `/maps/runtime` 全量模式。
- 不要让客户端用 `visibleEntities` 拼完整碰撞/占用。
- 不要每次改一格都重算全图并返回大数组（增量优先）。

---

### CC-06 Query / Affordance

**目标**：客户端可以问“这里能做什么/为什么不能”，不用复制服务端规则。

**交付物**

- 只读 HTTP 端点（或 WS 请求/响应；P0 优先 HTTP，简单可测）：
  - `GET /query/affordances?x&y&level&radius` → `{ entities: [{ networkId, kind, actions: [{ id, available, reason }] }] }`
  - `POST /query/place` `{ slot, x, y, level }` → `{ valid, reason, footprint, cells, occupiedBy }`
  - `POST /query/craft` `{ recipeId }` → `{ unlocked, station, missing, durationTicks, available }`
  - `GET /query/shop?npc=<networkId>` → `{ currency, items: [{ kind, count, price }] }`
  - `GET /query/quests?player=<networkId>` → 任务定义 + 进度
  - `GET /query/achievements?player=<networkId>` → 进度/条件/奖励
  - `GET /query/skills?player=<networkId>` → 曲线/技能效果
- 所有查询复用现有原子：
  - 交互：`interactionSystem` 的目标选择逻辑（抽成纯函数）
  - 放置：`placeableSystem` 的 canPlace/占用校验
  - 合成：`craftRecipe` 的 dry-run/解锁/站点校验
  - 商店：`dialogueSystem` 的定价函数
  - 任务/成就/技能：现有系统的只读投影
- 命令回执见 CC-04。
- 测试：查询结果与真实命令结果一致；未知实体 404/空；无副作用。

**验收**

- 客户端放置 UI 能显示 footprint/占用/不可用原因。
- 合成 UI 能显示“缺什么/未解锁/需要站点”。
- 商店 UI 能显示库存/实价。
- 任务/成就/技能 UI 不靠猜。

**不要做**

- 不要在 HTTP 层复制规则；调用仿真层函数。
- 不要让查询产生副作用/推进 tick。
- 不要暴露 eid。

---

### CC-07 State Sync Completion

**目标**：补齐客户端做血条/动画/状态/归属/腐烂/商店等必需的字段。多数是 `game.json` netSync 增加条目 + AoS 适配器。

**交付物**

在 `game/game.json` 的 `netSync.fields` 追加（保持旧条目不动）：

| 组件 | 字段 | 说明 |
|---|---|---|
| Health | `max` | 血条比例 |
| Attack | `value`, `range` | 攻击力/射程 |
| Defense | `value` | 防御 |
| Team | `id` | 阵营 |
| Perception | `visionRadius` | 感知范围 |
| Transform | `rot`, `scale` | 朝向/缩放 |
| Velocity | `vx`, `vy` | 走/停/朝向 |
| Cooldown | 全部实体 | 敌人攻击冷却（去掉 tags 或新增条目） |
| Projectile | `vx`, `vy`, `owner`, `damage`, `radius` | 投射物方向/归属 |
| ResourceNode | `max`, `infinite` | 资源 pips |
| LightSource | `fuelInfinite` | 篝火不要显示错误倒计时 |
| Placeable | `ownerNetworkId` | 能否拆除/归属 |
| GridOccupancy | `cellLevel` | 多层建造占用 |
| ItemMeta / Inventory | `spoilAt` | 食物腐烂倒计时（需适配器） |
| Ledger | `entries` | 商店库存（适配器已有） |
| Lifetime / ExpiresAt | 剩余 tick | 尸体/投射物 TTL |
| Nest | 可选 | 巢穴状态 |

另加：

- `StateMachine` AoS 适配器（`state`、`enteredTick`），让 tree burning/burnt、campfire burning 可见。
- `Modifiers` AoS 适配器（`stat` → entries），让中毒/加速/狂暴可见。
- 实体分类：`EntityState` 追加 `category: string`（`"player" | "enemy" | "npc" | "resource" | "item" | "container" | "structure" | "projectile"`），或同步 `tags` 派生字段；避免客户端用 `Health+Needs` 猜。
- `ItemStack.spoilAt`/`ItemMeta.spoilAt` 适配器输出剩余 tick 或绝对 tick（客户端用 `RoomState.tick` 换算）。

**验收**

- 客户端能画正确 HP 比例、资源 pips、篝火燃料、食物腐烂、装备归属、多层占用、敌人冷却、投射物方向、燃烧/中毒状态。
- `pnpm schema:check` 绿；客户端 schema 同步。
- 隐私：他人 `Inventory` 仍隐藏；`Equipment` 只给槽位索引时，额外给 `weaponKind/toolKind/armorKind` 或 `Equipment.weaponKind`，避免“看得到槽位看不到物品”。

---

### CC-08 Protocol / Schema 工具链

**目标**：版本可协商，schema 代码可生成，文档不再漂移。

**交付物**

1. `protocolVersion` 常量（例如 `2` 或日期）；放入 manifest 和 join options。
2. `GameRoom.onJoin` 读取 `options.protocolVersion`；不匹配时拒绝并回明确错误（`room.error` 或 join 失败）。
3. `tools/schemaCheck.ts`：
   - 保留 `--ts`。
   - 增加 `--gdscript`（schema 5 自带 GDScript codegen），输出到可配置路径（默认 `tools/generated/schema.gd`，或 `--out` 指向 `../godot-client`）。
   - `schema:check` 同时校验 TS 与 GDScript（若 Godot 目录存在）。
4. 文档修正：
   - `docs/CLIENT-INTEGRATION.md`：0.17/4.0.25 → 0.18.23/5.0.43；补新字段/端点。
   - `docs/MINIMAL-CLIENT-SPEC.md`：修正 `Kind` 矛盾；补 manifest/事件/查询。
   - `godot-client/Main.gd` 端口 3099 → 3000（或读取配置）。
5. 测试：join 版本不匹配被拒；codegen 一致性；manifest 版本稳定。

**验收**

- 客户端不再手抄 schema；`pnpm schema:check` 覆盖 Godot。
- 旧客户端得到明确“协议版本不匹配”，而不是解码乱码。
- 文档基线准确。

---

## 7. P1 / P2 计划（摘要）

### CC-09 UI Data Projection（P1）

- `/content` 扩展：
  - 任务：`type/goal/itemKind/victimKind/rewards/relationDelta/prerequisites`。
  - 成就：进度、条件结构化、奖励。
  - 技能：`curve`、`stat/perLevel/mode`。
  - 商店：库存/价格（或走 CC-06）。
  - 势力：`id/name/initialRep/members`。
  - 伤害类型/抗性、站点类型、物品 `effects/crit/damageType/resist`。
- 验收：UI 不再只显示 id/原始条件串。

### CC-10 Player Profile（P1）

- `PlayerState` 追加 `displayName`、`characterId`、`appearance`（opaque JSON）。
- 他人装备：`Equipment.weaponKind/toolKind/armorKind`（不放背包内容）。
- 验收：多人能看到名字、外观、手持武器/护甲。

### CC-11 Audio / VFX（P1）

- 客户端事件增加 `sfx`、`vfx`、`ambient`、`music`；manifest 提供 `audioId`/`vfxId` 集合。
- 服务端只发 id，不持有资源。
- 验收：命中/采集/制作/死亡/天气有音效/粒子事件。

### CC-12 Weather / Season View（P1）

- `RoomState` 追加 `dayIndex`、`seasonId`、`temperature`（或 per-player）、`weatherIntensity`。
- 事件：`weather-change`、`season-change`、`temperature-warning`。
- `/content` phases 补 `weatherSlotTicks`、`groundOverrides` 或走 `/maps/render`。
- 验收：季节/天气视觉与 HUD 有数据。

### CC-13 Map Decoration / World Map（P1）

- Tiled 导入保留 tileset/decoration/object 层，或新增 `decor` 配置（按 biome/region 的装饰规则）。
- autotile mask：服务端至少输出邻接掩码（4/8/47-tile），客户端负责贴图。
- `GET /world/map-graph` + POI。
- 验收：地图不空、有世界图/小地图。

### CC-14 Network Feel（P1）

- `RoomState.serverTimeMs` 或 join 时下发 server clock；`PlayerState.lastProcessedSeq`。
- 固定步长（推荐）：`GameRoom` 用 accumulator 以 `fixedDtMs` 多步推进，避免 tick/dt 双时间基。
- `allowReconnection` + token（或继续 networkId，但加签名）。
- Godot 侧可用 `input()`/Predict 的前提：服务端 `defineInput` 或继续 JSON + 文档说明不支持预测。
- 验收：插值/预测/重连有明确契约。

### CC-15 Session / Auth / Rooms（P2）

- `onAuth`、角色创建、房间列表/匹配、多世界。
- networkId 绑定 session secret，防冒领。

### CC-16 Content Distribution / i18n（P2）

- manifest/asset bundle 版本；locale key；`labels` 改为 key→locale 表，不在 `src/register.ts` 硬编码中文。

### CC-17 Telemetry / Replay / Debug（P2）

- AI 路径/仇恨可视化、回放、指标；`debug_colliders` 改用 networkId。

---

## 8. 协议与实现规范

### 8.1 Schema 变更

- 追加字段只能放在**末尾**；已有字段索引不变。
- 新字段必须有默认值；旧客户端缺字段按默认值处理。
- 修改 `framework/net/colyseus/state/*.ts` 后：
  1. `pnpm schema:gen`；
  2. 提交 `src/network/colyseus/client-schema/schema.ts`；
  3. `pnpm schema:check`；
  4. 更新 `docs/CLIENT-INTEGRATION.md` 的字段表。
- 破坏性变更（删字段/改类型/改顺序）必须提升 `protocolVersion`。

### 8.2 事件

- 事件只做通知，不作为权威状态；客户端仍以 `RoomState` 为准。
- `seq` 每客户端单调递增；客户端按 `seq` 去重。
- 事件载荷不带 eid；实体用 networkId。
- 事件按 audience 过滤：`self` / `nearby` / `map` / `world`。
- 高频事件（伤害/移动）可合并/节流；低频事件（成就/任务）不丢。

### 8.3 查询

- 只读、无副作用、不推进 tick。
- 查询参数/返回用 networkId；未知实体返回 404/空。
- 复用仿真层校验函数，禁止复制规则。
- 查询结果必须与真实命令结果一致（同一校验函数）。

### 8.4 地图

- `MapGeometry` 仍是底板；`EffectiveGround` 是派生视图，不写回。
- 增量只发 `{tileIndex, field, value}`；全量保留旧路径。
- 碰撞/占用快照必须包含建造物（`Structure`/`Placeable`/`GridOccupancy`）。
- 逐层几何只在 CC-13/后续扩展；P0 不做。

### 8.5 时间

- 当前 `GameRoom` 把实际 `deltaTime` 传给 `step`，而 dayNight/制作/重生用 `tick × fixedDtMs`，是双时间基。
- 推荐在 CC-14 改为固定步长 accumulator；在此之前，所有新的动作时间轴必须用 `startedTick + durationTicks`（tick 基准），不要混用 ms。
- 客户端动画进度用 `(RoomState.tick - startedTick) / durationTicks`；如果服务器卡顿，接受动画变慢，不要本地追帧。

---

## 9. 验收清单（Definition of Done）

### 9.1 每个 CC 完成时

- [ ] 代码实现 + 单元/集成测试。
- [ ] `pnpm test` 全绿。
- [ ] `pnpm build` 零错误。
- [ ] `pnpm tools validate` 通过。
- [ ] `pnpm schema:check` 通过（若改 schema）。
- [ ] 文档更新（至少 `CLIENT-INTEGRATION.md` 或本文件对应节）。
- [ ] 没有把游戏语义写进 `framework/`。

### 9.2 P0 整体完成时

- [ ] Godot 能拉 manifest，按地图/图块语义渲染 TileMapLayer。
- [ ] Godot 能按 `mapVersion` 增量更新地图，不再整图重拉。
- [ ] 季节/天气地面与服务器一致（`/maps/render`）。
- [ ] 攻击/采集/投掷有动作状态与阶段，动画与伤害对齐。
- [ ] 伤害/死亡/采集/制作/任务/成就/袭击预警有客户端事件。
- [ ] 放置预览/合成/商店/任务查询有接口，命令失败有错误码。
- [ ] 血条/走停/朝向/燃烧/状态/归属/腐烂/商店库存字段可见。
- [ ] 协议版本握手 + GDScript schema 生成。
- [ ] 双客户端测试：隐私不泄漏、事件不串、兴趣裁剪正常。
- [ ] 无鉴权/networkId 冒领至少有明确风险记录（建议 P0 一并修）。

### 9.3 手工冒烟

```bash
# 终端 1
cd game_server_test && pnpm dev

# 终端 2
curl -s localhost:3000/client/manifest | head
curl -s "localhost:3000/maps/runtime?mapId=island&sinceVersion=" | head
curl -s "localhost:3000/maps/render?mapId=island" | head
curl -s "localhost:3000/maps/collision?mapId=island&level=0" | head
curl -s -X POST localhost:3000/query/craft -H 'content-type: application/json' -d '{"recipeId":"wood_axe"}'
```

- 用 HTML 客户端/Godot 连接，确认移动、采集、攻击、制作、换图、重连。
- 两个客户端在线，确认 A 看不到 B 的背包内容/任务/对话（按隐私策略）。
- 放一个墙，确认碰撞/放置预览更新。
- 触发野火/风暴，确认 `terrain-writeback`/`weather-change` 事件与地图增量。

---

## 10. 风险与回滚

| 风险 | 处理 |
|---|---|
| Action Timeline 改动战斗/采集，旧测试大面积失败 | 配置缺省时走旧瞬时路径；先 attack/gather/throw 三个动作，逐步迁移 |
| Schema 追加字段导致旧客户端解码错位 | 只追加末尾；提升 `protocolVersion`；客户端可先忽略新字段 |
| 地图增量基线不一致 | 读档/重建时保留出厂底板；`sinceVersion` 不匹配直接回全量 |
| 有效地面逐格计算成本高 | 按 `renderVersion` 缓存；只在该图有玩家时计算；必要时稀疏返回 |
| 事件量大 | 批量发送、按 audience 过滤、低频事件优先；伤害数字可客户端合并 |
| 查询端点被刷 | 只读 + 频率限制 + 复用输入校验；不要每帧查询 |
| 隐私泄漏 | 所有新事件/查询走 per-client 过滤；测试双客户端 |
| 版本漂移 | CI 跑 `schema:check`；manifest 带版本；文档基线统一 |

---

## 11. 附录

### A. 最小 `ClientManifest` 形状

见 CC-01 JSON 示例。实现时字段可增不可减；未实现段用空数组/空对象，不要 `undefined`。

### B. `ActionTimeline` 示例

见 CC-03 JSON 示例。`phases[].endTick` 必须严格递增且 ≤ `durationTicks`；`events[].phase` 必须引用已声明 phase。

### C. 事件示例

```jsonc
{ "seq": 42, "tick": 12345, "type": "hit", "data": { "attacker": 7, "target": 12, "damage": 18, "crit": false, "damageType": "pierce" } }
{ "seq": 43, "tick": 12345, "type": "death", "data": { "victim": 12, "kind": "boar" } }
{ "seq": 44, "tick": 12346, "type": "craft-complete", "data": { "recipeId": "wood_axe", "outputs": [["axe", 1]] } }
```

### D. 错误码

| code | 含义 |
|---|---|
| `invalid` | 参数非法/未知命令 |
| `no_item` | 槽位无物品/数量不足 |
| `inventory_full` | 背包满 |
| `out_of_range` | 距离/地图/层不匹配 |
| `cooldown` | 冷却中 |
| `rate_limited` | 命令频率超限 |
| `dead` | 死亡/重生窗口 |
| `not_owner` | 非放置者，不能拆 |
| `blocked` | 放置阻挡/占用 |
| `unknown` | 未分类 |

### E. 建议新增文件

- `framework/content/manifest.ts`
- `framework/content/presentation.ts`
- `framework/config/schema/PresentationSchema.ts`
- `framework/config/schema/ActionSchema.ts`
- `framework/simulation/actions/actionState.ts`
- `framework/simulation/actions/actionSystem.ts`
- `framework/simulation/clientEvents.ts`
- `framework/net/colyseus/clientManifest.ts`（或复用 content）
- `game/presentation/maps.json`
- `game/actions/actions.json`
- `docs/CLIENT-CONTRACT-EXECUTION.md`（本文件）

### F. 术语表

见 §0.4。执行时遇到不确定的术语，先按 §0.4/§4 的源码路径核对，不要凭旧文档猜测。

---

## 12. 执行状态与记录

> 本节是**唯一进度看板**。执行者开始/结束一个 CC 时都必须让本节反映真实状态；后续子代理以本节为准决定是否还需要做。

### 12.1 状态表

状态取值：`待执行` / `进行中` / `已完成` / `部分完成` / `阻塞`。

| CC | 模块 | 优先级 | 状态 | 轮次 | 执行者 | 更新日期 | 证据 / 备注 |
|---|---|---|---|---|---|---|---|
| CC-01 | Client Manifest | P0 | 进行中 | R2 | fixer | 2026-11-23 | 依赖 CC-02/CC-08（均已交付） |
| CC-02 | 地图/图块语义表 | P0 | 已完成 | R1 | fixer | 2026-11-23 | `2a9eeee`；presentation 18/18 + validate 8 图/13 语义；约定路径 `game/presentation/maps.json` |
| CC-03 | Action Timeline + ActionState | P0 | 进行中 | R2 | fixer | 2026-11-23 | - |
| CC-04 | Client Event Outbox + Command Result | P0 | 待执行 | - | - | 2026-11-23 | - |
| CC-05 | Map Client View | P0 | 待执行 | - | - | 2026-11-23 | - |
| CC-06 | Query / Affordance | P0 | 待执行 | - | - | 2026-11-23 | 与 CC-05 共享 `server.ts`，需分轮 |
| CC-07 | State Sync Completion | P0 | 已完成 | R1 | fixer | 2026-11-23 | `7f10d8d`；netsync-completeness 13/13 + 全量 1266 passed（仅基线 2 fails）；另修 `spawn` 的 `Transform.scale` 初始化 |
| CC-08 | Protocol / Schema 工具链 | P0 | 已完成 | R1 | fixer | 2026-11-23 | server `5bdfa9d` / godot `903f659`；protocol-version + schema-gdscript + schema:check 全绿 |
| CC-09 | UI Data Projection | P1 | 进行中 | R2 | fixer | 2026-11-23 | - |
| CC-10 | Player Profile | P1 | 待执行 | - | - | 2026-11-23 | - |
| CC-11 | Audio / VFX | P1 | 待执行 | - | - | 2026-11-23 | 依赖 CC-04 |
| CC-12 | Weather / Season View | P1 | 待执行 | - | - | 2026-11-23 | - |
| CC-13 | Map Decoration / World Map | P1 | 待执行 | - | - | 2026-11-23 | 需先定装饰模型 |
| CC-14 | Network Feel | P1 | 待执行 | - | - | 2026-11-23 | - |
| CC-15 | Session / Auth / Rooms | P2 | 待执行 | - | - | 2026-11-23 | - |
| CC-16 | Content Distribution / i18n | P2 | 待执行 | - | - | 2026-11-23 | - |
| CC-17 | Telemetry / Replay / Debug | P2 | 待执行 | - | - | 2026-11-23 | - |

### 12.2 执行规则

1. **每轮最多 3 个子代理**；同一轮内的子代理不得共享写文件（见各 CC 小节与轮次派发说明）。共享文件（`server.ts`、`GameRoom.ts`、`GameSimulation.ts`、`game/game.json`、`aosSyncAdapters.ts`）必须由单轮单一执行者拥有。
2. **执行者不直接编辑本文件**：子代理在最终报告中给出「状态块」，由编排者（主会话）在子代理结束后写入本表与 §12.3；这样避免并行写冲突。
3. 每个子代理开始前必须读：§0、§3、§4、目标 CC 小节、§8、§9。完成时必须提供：
   - 改动文件清单（含新增文件）；
   - 运行的命令与结果（至少 `pnpm test` 中相关用例 + `pnpm build`）；
   - 未完成项 / 风险 / 建议下一步；
   - 可直接粘贴的状态块（CC、状态、日期、证据）。
4. **状态改为「已完成」的条件**：该 CC 小节的「验收」全部满足，且受影响的检查通过（`pnpm test`、`pnpm build`、`pnpm tools validate`、`pnpm schema:check`）。
5. **基线已知失败**（不是回归，不要为此阻塞）：`framework/__tests__/maps-http.test.ts` 有 2 个用例在干净基线上就失败（地图 `version` 指纹 `4490e6ee` vs `a0726bcf`）。新增代码不得扩大失败面；若任务正好触及该测试，可顺手修。
6. **提交策略：每个 lane 完成后立即单独提交**，不攒到最后统一提交。子代理不自行 `git commit`（同一工作树并发执行会互相混入文件、争抢 index.lock）；由编排者在子代理报告后，按该 CC 的文件清单显式 `git add <paths>` 后提交，提交信息带 CC 编号（如 `feat(client-contract): CC-02 map/tile semantics`），并把 commit hash 记入 §12.3 备注。
7. 不启动 `pnpm dev`（端口留给人工冒烟）、不新增依赖，除非该 CC 明确要求且在本节记录原因。
7. 任何跨出「文件所有权」的改动，先停在报告中说明，不要擅自修改其他 CC 的领地。

### 12.3 执行日志

| 日期 | 轮次 | CC | 结果 | 备注 |
|---|---|---|---|---|
| 2026-11-23 | R1 | CC-02 / CC-07 / CC-08 | 已派发 | 三个并行 lane，文件所有权见派发说明 |
| 2026-11-23 | R1 | CC-08 | 已完成 | server `5bdfa9d`（protocol 握手/GDScript codegen/文档基线），godot `903f659`（generated schema/端口/插件版本）；13 tests + `schema:check` 绿 |
| 2026-11-23 | R1 | CC-07 | 已完成 | `7f10d8d`（netSync + 适配器 + 文档 §3.5/K13）；补 `spawn` 的 `Transform.scale=1`；netsync 13/13、全量仅基线 2 fails |
| 2026-11-23 | R1 | CC-02 | 已完成 | `2a9eeee`（PresentationSchema + 查询/校验 + 8 图配置）；presentation 18/18、`tools validate` 通过；接口见报告，供 CC-01 消费 |
| 2026-11-23 | R2 | CC-01 / CC-03 / CC-09 | 已派发 | 三个并行 lane：Manifest（server.ts + presentation 扩展）、Action Timeline（sim/systems/game.json）、UI Data（catalog.ts） |
