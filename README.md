# 配置驱动的 2D 游戏服务端框架

基于 **Node.js + TypeScript + bitECS + Colyseus** 的无头游戏服务端。核心命题：**配置定义游戏，框架运行游戏，AI 可选生成配置**。

## 快速开始

```bash
pnpm install
pnpm dev      # tsx 热重载
pnpm build    # tsc 编译
pnpm start    # 运行 dist/src/index.js
pnpm test     # 运行测试
```

默认监听端口 **3001**，可通过 `.env` 中 `PORT` 覆盖。

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
  index.ts                  # 公共 API 入口
  api.ts                    # 注册函数 + list 函数
  world.ts                  # GameWorld 类型 + createGameWorld
  bootstrap.ts              # 所有 registry 创建与内置注册
  bootstrap/
    GameInstance.ts         # GameInstance{ world, systems, step, spawnInitial }
    loadGameDefinition.ts   # 加载 + zod 校验 game.json 及子配置
  components/               # ECS 组件 + componentRegistry
    componentRegistry.ts    # 组件注册表: 名 → defineComponent
    registerBuiltin.ts      # 注册 12 个内置组件
    transform.ts, physics.ts, combat.ts, ai.ts, inventory.ts, network.ts, timer.ts, tags.ts, size.ts
  systems/
    systemRegistry.ts       # 系统注册表 + buildSystems (拓扑排序)
    registerBuiltinSystems.ts
    core/                   # physicsSystem, movementSystem, collisionSystem
    gameplay/               # aiSystem, combatSystem, inventorySystem, interactionSystem, spawningSystem
  entities/
    archetypeRegistry.ts    # 原型注册表: kind → ArchetypeSpec
    spawn.ts                # spawnEntity(world, kind, overrides) — 通用实体工厂
  ai/
    blackboard.ts           # 每实体黑板
    btFactory.ts            # 行为树工厂 (配置 → mistreevous 树)
    btRunner.ts             # 行为树执行器
    actionRegistry.ts       # 动作注册表: 名 → ActionFactory
    nodes/actions/          # idle.ts, wander.ts
  map/
    types.ts                # MapRuntime / MapSource / MapZone 等类型
    tiled.ts                # Tiled JSON 解析
    buildRuntime.ts         # MapSource → MapRuntime (纯函数)
    generatorRegistry.ts    # 生成器注册表: generatorId → MapGenerator
    generated/simple.ts     # 默认程序化地图生成器
    exportGenerated.ts      # MapRuntime → JSON + PNG
  config/
    server.ts               # 端口 / CORS
    game.ts                 # tickRate 配置
    map.ts                  # 地图注册表读取
    schema/                 # zod schema: GameDefinition, Archetype, Behavior, Spawn, MapRegistry, Rule
  net/
    colyseus/               # Colyseus 网络适配器
      server.ts             # HTTP + WebSocket + /health /maps/runtime /debug/colliders
      rooms/GameRoom.ts     # 房间: 持有 GameInstance，委托 step
      state/                # RoomState, PlayerState, EntityState (Colyseus Schema)
    headless/
      HeadlessHost.ts       # 无传输驱动 GameInstance.step (测试/单机)
  utils/                    # logger, timer
  metrics.ts                # tick 性能指标
  __tests__/                # 35 个测试

src/
  index.ts                  # 入口
  main.ts                   # 启动 Colyseus 服务器
  register.ts               # bootstrapFramework() 注册扩展

game/
  game.json                 # GameDefinition 主入口
  entities/                 # 实体原型 (player.json, villager.json)
  behaviors/                # 行为树 (wander-default.json)
  rules/                    # 规则 (combat.json)
  spawns/                   # 生成规则 (populations.json)
  maps/                     # 地图清单 (registry.json)

tools/
  cli.ts                    # 统一 CLI 入口
  validate.ts               # 配置校验
  new-game.ts               # 脚手架
  list-registries.ts        # 列出注册表
  gen-map.ts                # 地图生成
  export-map.ts             # 地图导出
```

### 游戏循环

由 `GameRoom.setSimulationInterval` 驱动，每 tick：
1. 接收客户端输入 → Velocity
2. `gameInstance.step(dtMs)`
3. 系统按拓扑排序执行：AI → Physics → Movement → Collision → Combat → Spawning → Inventory → Interaction
4. 同步 ECS 状态 → Colyseus RoomState

### 配置系统

所有游戏内容由 `game/` 下的 JSON 定义，经 zod schema 校验 + 引用完整性检查后加载为 `LoadedGameDefinition`，挂载到 `GameWorld.gameDef`。系统从 `world.gameDef` 读取参数，不依赖全局 getter。

### 网络同步

Colyseus Schema 每 tick 同步。`EntityState` 的字段通过 `game.json` 的 `netSync.fields` 配置，选择性同步组件字段。服务端权威，客户端仅发送输入。

## 扩展指南

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
| ECS | bitecs ^0.4 |
| 网络 | @colyseus/core + @colyseus/ws-transport |
| Schema | @colyseus/schema + zod |
| 碰撞 | check2d |
| AI | mistreevous |
| 日志 | winston |
| 测试 | vitest |
