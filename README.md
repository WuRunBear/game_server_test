# 配置驱动的 2D 游戏服务端框架

基于 **Node.js + TypeScript + bitecs + Colyseus** 的无头游戏服务端。核心命题：**配置定义游戏，框架运行游戏，AI 可选生成配置**。

## 快速开始

```bash
pnpm install
pnpm dev      # tsx 热重载
pnpm build    # tsc 编译
pnpm start    # 运行 dist/src/index.js
pnpm test     # 运行测试（vitest，43 个用例）
```

默认监听端口 **3000**（见 `framework/config/server.ts`），可通过 `.env` 中 `PORT` 覆盖。

## 工具

```bash
pnpm tools validate                    # 校验 game/ 目录下所有配置
pnpm tools new-game --id my-game       # 生成 game/ + src/ 骨架
pnpm tools list-registries             # 列出已注册的原型/动作/系统
pnpm tools gen-map simple --out out/   # 调用生成器产出地图
pnpm tools export-map --out out/       # 导出当前地图为 JSON + PNG
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
    GameInstance.ts         # createGameInstance(gameDef) → { world, systems, step, spawnInitialEntities }
    loadGameDefinition.ts   # 加载 game.json + zod 校验 + 引用完整性检查
  simulation/               # 仿真抽象层 — 传输层与 ECS 的解耦接口
    SimulationPort.ts      # 接口: tick / addPlayer / removePlayer / submitInput / getDebugSnapshot
    GameSimulation.ts       # 实现: 内部聚合 GameInstance + ECS
    types.ts                # 纯数据 DTO: PlayerInput, TickSnapshot, TickResult
    index.ts                # 模块 barrel 导出
  components/               # ECS 组件 + componentRegistry
    componentRegistry.ts    # 组件注册表: 名 → defineComponent
    registerBuiltin.ts      # 注册 33 个内置组件
    index.ts                # barrel 导出
    transform.ts, size.ts, physics.ts (Velocity/Acceleration/Collider/ColliderShape),
    combat.ts (Health/Attack/Defense/Team), ai.ts (AIState/Target/BlackboardRef),
    perception.ts (SoA 感知), equipment.ts / craftingStation.ts (SoA 装备/站点),
    lightSource.ts / placeable.ts (SoA 光源/可放置),
    inventory.ts (AoS 例外), network.ts (NetworkId/LastSynced),
    timer.ts (Cooldown/Duration), tags.ts (Player/Enemy/NPC/Item/Resource),
    needs.ts / resourceNode.ts / loot.ts / intent.ts / kind.ts / itemMeta.ts (AoS 家族)
  systems/
    systemRegistry.ts       # 系统注册表 + buildSystems (拓扑排序, Kahn 算法)
    registerBuiltinSystems.ts   # 注册 15 个内置系统
    index.ts                # barrel 导出
    core/                   # physicsSystem, movementSystem, collisionSystem
    gameplay/               # perceptionSystem, aiSystem, combatSystem, spawningSystem,
                            # inventorySystem, interactionSystem, needDecaySystem,
                            # gatheringSystem, deathSystem, respawnSystem, equipmentSystem,
                            # dayNightCycleSystem
                            # (craftingSystem / placeableSystem 为命令驱动的原子模块，无 tick 体，不注册为系统)
  entities/
    archetypeRegistry.ts    # 原型注册表: kind → ArchetypeSpec
    registerBuiltinArchetypes.ts   # 注册 player, villager 2 个内置原型
    spawn.ts                # spawnEntity(world, archetype, componentRegistry, overrides)
  ai/
    actionRegistry.ts       # 动作注册表: 名 → ActionFactory (返回 State | boolean)
    btFactory.ts            # 行为树工厂 (配置 → mistreevous 树)
    btRunner.ts             # stepBehaviourTree(instance, ctx)
    blackboard.ts           # 每实体黑板 (perception.target 等 key)
    registerBuiltinActions.ts   # 注册 Idle/Wander/Chase/Flee/Attack/Sleep/IsTargetInVision/IsTargetNotInVision/InAttackRange/IsNight/IsInLight
    nodes/actions/          # idle.ts, wander.ts, chase.ts, flee.ts, attack.ts, sleep.ts
    nodes/conditions/       # isTargetInVision.ts, isTargetNotInVision.ts, inAttackRange.ts, isNight.ts, isInLight.ts
    nodes/steer.ts          # 移动方向/边界钳制共用工具
  map/
    types.ts                # MapRuntime / MapSource / MapZone / Vec2
    tiled.ts                # Tiled JSON 解析 (collision/objects/zones 三层)
    buildRuntime.ts         # 纯函数: MapSource → MapRuntime
    generatorRegistry.ts    # 生成器注册表: generatorId → MapGenerator
    registerBuiltinGenerators.ts   # 注册 simple 默认生成器
    generated/simple.ts     # 默认程序化地图生成器 (xorshift32 RNG)
    exportGenerated.ts       # MapRuntime → JSON + PNG (手写 PNG 编码器)
    index.ts                # barrel 导出
  config/
    server.ts               # .env → ServerConfig { port, wsPath, corsOrigins }，默认端口 3000
    game.ts                 # tickRate 静态配置
    map.ts                  # 地图清单（registry.json）读取
    index.ts                # barrel 导出
    schema/                 # zod schema: GameDefinition / Archetype / Behavior / / Spawn / MapRegistry / Rule
  net/
    colyseus/
      server.ts             # startColyseusServer — HTTP + WebSocket + /health /maps/runtime /debug/colliders
      rooms/GameRoom.ts     # 房间: 持有 SimulationPort，委托 tick（纯传输/输入/同步/调试，无 ECS 导入）
      state/                # RoomState, PlayerState, EntityState (Colyseus Schema, 字段按 netSync 配置映射)
    headless/
      HeadlessHost.ts       # runHeadless(sim, opts) — 无传输驱动 tick，返回 TickResult[]
  utils/                    # logger.ts (winston), timer.ts (clampMs)
  metrics.ts                # tick 性能指标 (EMA avg)
  repository.ts             # Repository 接口 (持久化抽象)
  postgres.ts, redis.ts     # 占位 stub
  bitecs-legacy.d.ts         # bitecs legacy API 手工类型声明
  __tests__/framework.test.ts   # 43 个测试，20 个 describe 块

src/
  index.ts                  # 入口: dotenv/config → main()
  main.ts                   # bootstrapFramework() → startColyseusServer({ gameJsonPath })
  register.ts               # 扩展注册入口（当前仅调用 bootstrapFramework()，无自定义扩展）

game/
  game.json                 # GameDefinition 主入口：tickRate=20, 15 个系统, netSync 配置
  entities/                 # player, villager, boar, rabbit, berry_bush, tree, water_pool, item, rock, campfire, wolf
  behaviors/                # wander-default, boar-hostile, rabbit-flee, wolf-night
  rules/                    # combat.json, needs.json, respawn.json, crafting.json, daynight.json, place.json
  spawns/                   # populations.json（wolf 规则带 condition: "isNight"）
  items/                    # berry, wood, water, raw_meat, stone, axe, stone_axe, spear, berry_pie, cooked_meat, campfire_kit (item kind 数据)
  maps/                     # registry.json

tools/
  cli.ts                    # 统一 CLI 入口
  validate.ts, new-game.ts, list-registries.ts, gen-map.ts, export-map.ts
```

> 上述目录树以源码为准，文档可能滞后。核实时可 `pnpm tools list-registries` 或直接读 `framework/*/registerBuiltin*.ts`。

### 游戏循环

由 `GameRoom.setSimulationInterval` 驱动，每 tick：
1. 接收客户端输入 → Velocity
2. `gameInstance.step(dtMs)`
3. 系统按拓扑排序执行：DayNight → AI → Physics → Movement → Collision → Combat → Spawning → Inventory → Interaction → Equipment
4. 同步 ECS 状态 → Colyseus RoomState

### 配置系统

所有游戏内容由 `game/` 下的 JSON 定义，经 zod schema 校验 + 引用完整性检查后加载为 `GameDefinition`，挂载到 `GameWorld.gameDef`。系统从 `world.gameDef` 读取参数，不依赖全局 getter。

### 网络同步

Colyseus Schema 每 tick 同步。`EntityState` 的字段通过 `game.json` 的 `netSync.fields` 配置，选择性同步组件字段（无硬编码）。服务端权威，客户端仅发送输入。仿真与传输解耦：`GameRoom`（联机）与 `HeadlessHost`（测试/单机）共用同一 `SimulationPort.tick(dtMs)`，`GameRoom` 不导入任何 bitecs / ECS 符号。

## 扩展指南

> 本节为操作速查。**战略级约束见 `AGENTS.md` §AI 协作铁律**（游戏逻辑永远不写进 framework/、即需即补、通用的接口最小的实现）。

### 注册扩展

在 `src/register.ts` 中通过框架公共 API 注册：

```ts
import { registerSystem, registerComponent, registerAction, registerGenerator, registerRuleModule } from "framework";

registerComponent("Hunger", Hunger);
registerSystem({ id: "hunger", factory: (world) => hungerSystem(world), after: ["combat"] });
registerAction("Flee", createFleeAction);
registerGenerator("dungeon", generateDungeon);
registerRuleModule("damage-formula", customDamageFormula);
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