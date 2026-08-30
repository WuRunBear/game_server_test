# 配置驱动的 2D 游戏服务端框架

基于 **Node.js + TypeScript + bitecs + Colyseus** 的无头游戏服务端。核心命题：**配置定义游戏，框架运行游戏，AI 可选生成配置**。

## 快速开始

```bash
pnpm install
pnpm dev      # tsx 热重载
pnpm build    # tsc 编译
pnpm start    # 运行 dist/src/index.js
pnpm test     # 运行测试（vitest，452 个用例）
```

默认监听端口 **3000**（见 `framework/config/server.ts`），可通过 `.env` 中 `PORT` 覆盖。

## 工具

```bash
pnpm tools validate                    # 校验 game/ 配置（输出含每图管道链与实体规则数）
pnpm tools new-game --id my-game       # 生成 game/ + src/ 骨架
pnpm tools list-registries             # 列出已注册的原型/动作/系统/生成积木
pnpm tools gen-map island --out out/   # 生成地图（参数是地图 key：island/cave/tiled-demo）
pnpm tools export-map island --out out/ [--palette <file>]  # 导出 JSON+PNG（色表为工具参数）
```

## 架构

### 四层结构

```
tools/        ← AI/工具层 — 通过 framework 公共 API 操作框架
src/          ← 游戏入口 — bootstrapFramework → 启动服务
framework/    ← 框架核心 — 游戏无关，所有通用逻辑
game/         ← 游戏配置 — 纯 JSON：实体、行为、地图、规则、生成点
```

依赖方向严格自上而下：`tools → framework`、`src → framework`。`framework` 不反向依赖任何游戏代码或工具代码。

### 目录结构

```
framework/
  index.ts                  # 公共 API 入口（register* + createGameInstance 等）
  api.ts                    # 全局 register* 函数 + list* 函数（操作单例 registry）
  world.ts                  # GameWorld 类型 + createGameWorld
  bootstrap.ts              # bootstrapFramework() — 创建并填充所有 registry（模块单例）
  bootstrap/
    GameInstance.ts         # createGameInstance(gameDef) → { world, systems, step, beforeSystems }
                            # （bootMaps 全量构建地图；step 内 tick 自增后、系统前跑演化钩子）
    loadGameDefinition.ts   # 加载 game.json + zod 校验 + 引用完整性检查（含实体规则 kind/condition/region）
  simulation/               # 仿真抽象层 — 传输层与 ECS 的解耦接口
    SimulationPort.ts      # 接口: tick / addPlayer / removePlayer / submitInput / getDebugSnapshot
    GameSimulation.ts       # 实现: 内部聚合 GameInstance + ECS（async 装配：BootDeps 单一读档通道、
                            #   定时存档/读档恢复/离线补差/输入校验接线、beforeSystems 演化钩子注入）
    types.ts                # 纯数据 DTO: PlayerInput, TickSnapshot, TickResult, SimulationOptions
    interest.ts             # computeInterest — 视野半径裁剪（own 恒可见）
    inputValidation.ts      # 输入校验（anti-cheat）：移动速度上限 + 命令频率 tick 窗口限流
    aosSyncAdapters.ts      # AoS 组件同步适配器（展平为 numbers/strings，按 tags 限定查询）
    index.ts                # 模块 barrel 导出
  persistence/              # 世界快照持久化
    worldSerializer.ts      # serializeWorld / restoreWorld（SoA+AoS 全量 + 全部地图几何快照 maps 同盘，
                            #   瞬态组件跳过，networkId 保真）
    fileRepository.ts       # createFileRepository — JSON 文件仓储（默认后端，原子写）
  components/               # ECS 组件 + componentRegistry
    componentRegistry.ts    # 组件注册表: 名 → defineComponent
    registerBuiltin.ts      # 注册 41 个内置组件
    index.ts                # barrel 导出
    transform.ts, size.ts, physics.ts (Velocity/Acceleration/Collider/ColliderShape),
    combat.ts (Health/Attack/Defense/Team), ai.ts (AIState/Target/BlackboardRef),
    perception.ts (SoA 感知), equipment.ts / craftingStation.ts (SoA 装备/站点),
    lightSource.ts / placeable.ts (SoA 光源/可放置), gridOccupancy.ts / portal.ts (SoA 网格占用 / AoS 传送门),
    dialogue.ts / dialogueSource.ts / quest.ts / relation.ts (AoS 对话会话/对话源/任务/好感),
    inventory.ts (AoS 例外), network.ts (NetworkId/LastSynced),
    timer.ts (Cooldown/Duration), tags.ts (Player/Enemy/NPC/Item/Resource),
    needs.ts / resourceNode.ts / loot.ts / intent.ts / kind.ts / itemMeta.ts / entityMap.ts / spawnPoint.ts (AoS 家族)
  systems/
    systemRegistry.ts       # 系统注册表 + buildSystems (拓扑排序, Kahn 算法)
    registerBuiltinSystems.ts   # 注册 16 个内置系统
    index.ts                # barrel 导出
    core/                   # physicsSystem, movementSystem, collisionSystem
    gameplay/               # perceptionSystem, aiSystem, combatSystem,
                            # inventorySystem, interactionSystem, needDecaySystem,
                            # gatheringSystem, deathSystem, respawnSystem, equipmentSystem,
                            # dayNightCycleSystem, portalSystem, questSystem
                            # (craftingSystem / placeableSystem / deconstructSystem / dialogueSystem
                            #  为命令驱动的原子模块，无 tick 体，不注册为系统)
  entities/
    archetypeRegistry.ts    # 原型注册表: kind → ArchetypeSpec
    registerBuiltinArchetypes.ts   # 注册 player, villager 2 个内置原型
    spawn.ts                # spawnEntity(world, archetype, componentRegistry, overrides)
  ai/
    actionRegistry.ts       # 动作注册表: 名 → ActionFactory (返回 State | boolean)
    btFactory.ts            # 行为树工厂 (配置 → mistreevous 树)
    btRunner.ts             # stepBehaviourTree(instance, ctx)
    blackboard.ts           # 每实体黑板 (perception.target 等 key)
    registerBuiltinActions.ts   # 注册 Idle/Wander/Chase/Flee/Attack/Sleep/IsTargetInVision/InAttackRange/IsNight/IsInLight
    nodes/actions/          # idle.ts, wander.ts, chase.ts, flee.ts, attack.ts, sleep.ts
    nodes/conditions/       # isTargetInVision.ts, inAttackRange.ts, isNight.ts, isInLight.ts
    nodes/steer.ts          # 移动方向/边界钳制共用工具
  map/                      # 地图系统（五层，游戏无关）
    geometry/               # 数据层 — 不可变 MapGeometry
      types.ts              # MapGeometry / MapGeometryGrid / RegionMeta（regions Map 插入序 = regionOfTile 索引序）
      query.ts              # walkableAt / regionOf / tileAt 纯函数查询（越界安全）
      snapshot.ts           # serializeGeometry / deserializeGeometry（SerializedMapGeometry 纯 JSON 快照）
      version.ts            # computeGeometryVersion（fnv1a32 内容指纹）+ describeGeometry（/maps/meta 元信息）
    generate/               # 生成层 — 配置 → 几何的纯生产管线
      types.ts              # GeometryDraft / GenerationContext / MapGenerator ((ctx) => void)
      pipeline.ts           # buildMapGeometry(config, registry) — 管道执行 + 冻结 + 内容指纹
      validate.ts           # validateMapGeometry 结构校验（硬错误抛错，软告警记日志）
      generatorRegistry.ts  # 生成积木注册表: 名 → MapGenerator
      rng.ts                # xmur3 + mulberry32 确定性随机流（deriveStream 按 seed+步骤序号派生）
      registerBuiltin.ts    # registerBuiltinMapGenerators — 注册四个内置积木
      blocks/               # 内置积木: noiseTerrain.ts（bandLevel+groundPalette+nonWalkableSemantics）、
                            #   climateRegions.ts（names[] 序 = 区域索引序，隐式 wilderness）、
                            #   roomCorridor.ts（地形级雕挖 + union-find 连通）、
                            #   tiledSource.ts（Tiled JSON 降级为积木，无文件 I/O）
    evolution/              # 演化层 — 实体规则补差引擎
      schema.ts             # EntityRule（map/region/kind/max/every/mode=density|exact|template/condition/at）
      placement.ts          # pickPoint 确定性选点（候选序列 = (seed, mapKey, ruleId, timeSlot) 纯函数，32 次上限）
      engine.ts             # evolve 补差引擎（槽绝对对齐 timeSlot、(from, to] 边界、只增不删早退、template 整组原子）
    runtime/                # 运行时 — 开机编排与真实依赖装配
      boot.ts               # bootMaps 开机唯一分支地（快照回填 / 生成+初始演化）+ 引用校验 + 首份 WorldRecord
      spawn.ts              # pickSpawnPosition（random/seededRandom/exact，返回像素坐标）
      clock.ts              # advanceTickTo / computeOfflineTicks（复用 world.time.tick，离线上限截断告警）
      evolveDeps.ts         # createMapEvolveDeps — 引擎依赖接到真实 ECS（tile↔像素换算）
    switchMap.ts            # movePlayerToMap — per-player 换图 + 传送原子
    exportGenerated.ts      # exportGeometryArtifacts — MapGeometry → JSON + PNG（色表为工具参数）
  config/
    server.ts               # .env → ServerConfig { port, wsPath, corsOrigins }，默认端口 3000
    game.ts                 # tickRate 静态配置
    index.ts                # barrel 导出
    schema/                 # zod schema: GameDefinition / Archetype / Behavior / Rule（含 Server/Player）/ MapRegistry / ItemKind / Dialogue / Quest
  net/
    colyseus/
      server.ts             # startColyseusServer — HTTP + WebSocket + /health /maps/meta /maps/runtime（x-map-version 缓存头） /debug/colliders
      rooms/GameRoom.ts     # 房间: 持有 SimulationPort，委托 tick（纯传输/输入/同步/调试，无 ECS 导入）
      state/                # RoomState, PlayerState, EntityState (Colyseus Schema, 字段按 netSync 配置映射)
    headless/
      HeadlessHost.ts       # runHeadless(sim, opts) — 无传输驱动 tick，返回 TickResult[]
  utils/                    # logger.ts (winston), timer.ts (clampMs)
  metrics.ts                # tick 性能指标 (EMA avg)
  repository.ts             # Repository 接口 (持久化抽象，WorldRecord 世界快照，含 maps 地理快照)
  postgres.ts, redis.ts     # 占位 stub（接口已对齐，等真实部署需求）
  bitecs-legacy.d.ts         # bitecs legacy API 手工类型声明
  __tests__/                # 41 个测试文件 / 452 个用例（U1–U7/I1–I5 地图矩阵 + 各切片回归）

src/
  index.ts                  # 入口: dotenv/config → main()
  main.ts                   # bootstrapFramework() → startColyseusServer({ gameJsonPath })
  register.ts               # 扩展注册入口（当前仅调用 bootstrapFramework()，无自定义扩展）

game/
  game.json                 # GameDefinition 主入口：tickRate=20, 16 个系统, map.registry/entityRules/default, netSync 配置
  entities/                 # player, villager, boar, rabbit, berry_bush, tree, water_pool, item, rock, campfire, wolf, wall, floor, door, fence, furniture, portal, portal_back
  behaviors/                # wander-default, boar-hostile, rabbit-flee, wolf-night
  rules/                    # combat.json, needs.json, respawn.json, crafting.json, daynight.json, place.json (gridSnap), server.json, player.json (出生规则)
  maps/                     # registry.json（island/cave/tiled-demo 三图）+ entity-rules.json（16 条实体演化规则）+ tiled-demo.json
  items/                    # berry, wood, water, raw_meat, stone, axe, stone_axe, spear, berry_pie, cooked_meat, campfire_kit, wall_kit, floor_kit, door_kit, fence_kit, furniture_kit (item kind 数据)
  dialogues/                # villager.json（对话树：接任务/交任务/好感选项）
  quests/                   # quests.json（collect_axe 收集型 / hunt_task 击杀型）

tools/
  cli.ts                    # 统一 CLI 入口
  validate.ts, new-game.ts, list-registries.ts, gen-map.ts, export-map.ts
```

> 上述目录树以源码为准，文档可能滞后。核实时可 `pnpm tools list-registries` 或直接读 `framework/*/registerBuiltin*.ts`。

### 游戏循环

由 `GameRoom.setSimulationInterval` 驱动，每 tick：
1. 接收客户端输入 → Velocity
2. `gameInstance.step(dtMs)`：tick 自增后、系统循环前先跑 beforeSystems 演化钩子（对每张激活图 `evolve(tick-1, tick)` 补差实体）
3. 系统按拓扑排序执行（game.json 启用序）：DayNight → Perception → AI → Physics → Movement → Collision → Combat → NeedDecay → Inventory → Gathering → Interaction → Equipment → Death → Respawn → Portal → Quest
4. 同步 ECS 状态 → Colyseus RoomState

### 配置系统

所有游戏内容由 `game/` 下的 JSON 定义，经 zod schema 校验 + 引用完整性检查后加载为 `GameDefinition`，挂载到 `GameWorld.gameDef`。系统从 `world.gameDef` 读取参数，不依赖全局 getter。

### 网络同步

Colyseus Schema 每 tick 同步。`EntityState` 的字段通过 `game.json` 的 `netSync.fields` 配置，选择性同步组件字段（无硬编码）。服务端权威，客户端仅发送输入。仿真与传输解耦：`GameRoom`（联机）与 `HeadlessHost`（测试/单机）共用同一 `SimulationPort.tick(dtMs)`，`GameRoom` 不导入任何 bitecs / ECS 符号。

### 持久化与联机完整度

由 `game/rules/server.json`（`ServerRuleSchema` 校验）驱动，全部经 `createGameSimulation(gameDef, options)` 注入：

- **持久化**：`saveIntervalMs` + `saveId` 开启定时存档（`worldSerializer` 全量快照 → `createFileRepository` 写 `data/saves/`，可用 `SAVE_DIR` 覆盖目录）；`createGameSimulation` 是 async，装配处预载存档并经 `BootDeps { loadRecord, saveRecord }` 单一通道注入 bootMaps 与 restoreWorld。`WorldRecord` 含 `maps`（全部地图几何快照，与实体同盘）并复用 `savedAt/tick/timeOfDay`；读档时 bootMaps 按快照回填各图、restoreWorld 恢复实体与全局时刻，玩家实体由 `addPlayer` 复用绑定（networkId/进度保留）。实体地图归属唯一来源 = 各实体 `EntityMap`（旧 `WorldRecord.mapId` 字段已删除，旧存档直接废弃，无兼容代码）。读档后按墙钟离线补差：`computeOfflineTicks`（上限 `DEFAULT_MAX_OFFLINE_TICKS = 1,728,000` ≈ 24h@20tps，超限截断 + 告警）→ 单次 `evolve` → `advanceTickTo` 落边界。
- **兴趣管理**：`interest` 恒计算（`computeInterest` 经 `GameSimulation.tick` 调用——先按玩家所属地图过滤，再可选按 `viewRadius` 半径裁剪；未配置 `viewRadius` 时同图全量）。每个客户端经 `PlayerState.visibleEntities` 收取本图可见实体（own 恒可见）；`PlayerState.mapId` 同步玩家当前地图；`RoomState.mapId/entities` 已移除（协议断代，旧客户端不兼容——实体同步恒走 per-client 可见表）。
- **输入校验**：`maxMoveSpeed` 超速输入被拒（记日志）、`maxCommandsPerSec` 命令频率限流；未配置时不校验。

### 建造与场景切换

- **建造**：`place` 命令（`ItemKindSchema.place` → `placeableSystem.placeEntity`）放置 Placeable 实体——`rules/place.json` 的 `gridSnap` 开启时占位矩形对齐地图网格（`GridOccupancy` 格组写入 + 同格重放被拒，墙/地板可无缝拼接）；`deconstruct` 命令（`deconstructSystem`）拆除，仅放置者可拆（`Placeable.ownerNetworkId`，0=世界物不可拆，不返还材料）。静态碰撞：无 `Velocity` 的实体（建筑/资源）注册为静态碰撞体，不会被推开。
- **场景切换**：`Portal` 组件（AoS，声明 targetMap + 传送坐标）+ `portalSystem` tick 逐配对检测「玩家与 portal 同图（entityMapOf 相等）且 AABB 相交」→ `movePlayerToMap`（`framework/map/switchMap.ts`）只移动触发玩家（换图 + 传送，可省略 dest 缺省目标图几何中心），不同玩家互不影响（per-player 语义：任一玩家触发只切换自身地图）。传送门实体由演化引擎 exact 规则布置（固定落点），开机 bootMaps 校验配对可达（落点指向对端门邻近格，Chebyshev ≤ 2）与目标图存在性。全部配置图开机即构建并常驻 `world.activeMaps`（空图也照常演化/碰撞）；玩家当前地图经 `PlayerState.mapId` 同步给客户端。

### 对话与任务（社交进度）

- **对话**：`talk` 输入意图（新交互键）→ `interactionSystem` 路由最近 NPC → `dialogueSystem.startDialogue` 打开对话树（`game/dialogues/*.json`：节点文本 + 选项 + 效果）；`dialogue` 命令（`PlayerCommand`）推进节点——效果失败停留可重试，`__end__` 结束。玩家会话状态在 `Dialogue` AoS 组件（瞬态，netSync 同步选项文本给客户端渲染 UI）。
- **任务**：`game/quests/*.json` 定义（collect 收集型：背包持有 itemKind ≥ goal；kill 击杀型：玩家击杀 victimKind 计数）+ `questSystem` tick 体推进进度（ACTIVE → READY）+ `dialogueSystem` 效果驱动 accept/submit（`quest_accept`/`quest_submit` 效果）。提交结算：collect 型消耗任务物品（dry-run 防丢产出）+ 奖励物品 + 好感。任务状态在 `Quest` AoS 组件（持久，随玩家入档）。
- **好感**：`Relation` AoS 组件（玩家↔NPC kind 好感值，持久入档）+ `addRelation/getRelation` 原子；`relation_delta` 对话效果与任务提交奖励写入。
- **事件总线**：`framework/events/gameEvents.ts` 帧内事件（emit/consume，step 帧首清空）——`combatSystem` 致命一击发 `killed` 事件，`questSystem` 击杀型任务消费。

## 扩展指南

> 本节为操作速查。**战略级约束见 `AGENTS.md` §AI 协作铁律**（游戏逻辑永远不写进 framework/、即需即补、通用的接口最小的实现）。

### 注册扩展

在 `src/register.ts` 中通过框架公共 API 注册：

```ts
import { registerSystem, registerComponent, registerAction, registerRuleModule } from "framework";

registerComponent("Hunger", Hunger);
registerSystem({ id: "hunger", factory: (world) => hungerSystem(world), after: ["combat"] });
registerAction("Flee", createFleeAction);
registerRuleModule("damage-formula", customDamageFormula);
```

### 自定义生成积木

地图内容由生成积木管道产出（`game/maps/registry.json` 的 `pipeline[].generator` 引用积木注册名）。框架内置四积木（noise-terrain / climate-regions / room-corridor / tiled-source）经 `framework/map/generate/registerBuiltin.ts` 的 `registerBuiltinMapGenerators` 接线；自定义积木实现 `MapGenerator` 签名并注册到同一注册表实例：

```ts
import type { GenerationContext } from "map/generate/types";
import { getRegistries } from "framework";

// 积木：向 ctx.geometry 草稿累积写入地理数据，无返回值
function maze(ctx: GenerationContext): void {
  // 首积木负责设定尺寸并分配缓冲；后续积木在其上改写
  // ctx.rng 是本步骤的独立确定性随机流（同 seed 同产出）
  // ctx.params 是该步骤在 registry.json 里声明的自有参数切片
}

// bootstrapFramework() 之后注册（幂等单例注册表）
getRegistries().mapGeneratorRegistry.register("maze", maze);
```

然后在 `game/maps/registry.json` 的管道中引用：

```json
{ "kind": "pipeline", "seed": 7, "initialAgeTicks": 0,
  "pipeline": [ { "generator": "noise-terrain", "params": { "width": 64, "height": 64, "tileWidth": 16, "tileHeight": 16, "bandLevel": 0.35, "groundPalette": { "1": 0.35, "2": 1 }, "nonWalkableSemantics": [1] } },
                { "generator": "maze" } ] }
```

### 配置实体

在 `game/entities/` 中创建 JSON：

```json
{
  "kind": "boar",
  "tags": ["NPC"],
  "components": {
    "Health": { "current": 60, "max": 60 },
    "Collider": { "shape": "circle", "radius": 8 }
  },
  "behavior": "boar-wander",
  "team": 2
}
```

然后在 `game.json` 的 `systems` 中启用相关系统即可。

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js >= 22 (ESM) |
| 语言 | TypeScript ^5.8 |
| ECS | bitecs ^0.4 (legacy API) |
| 网络 | @colyseus/core + @colyseus/ws-transport |
| Schema | @colyseus/schema + zod ^4 |
| 碰撞 | check2d ^9 |
| AI | mistreevous ^4 |
| 日志 | winston ^3 |
| 测试 | vitest ^4 |
| 开发运行 | tsx ^4, tsc-alias |