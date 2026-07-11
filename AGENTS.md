# AGENTS.md — 项目高层次概括

> 本文件为 AI 代理（opencode/Claude/Cursor 等）提供项目上下文，供会话间复用。

## 项目定位

**配置驱动的 2D 游戏服务端框架**，基于 Node.js + TypeScript + bitecs + Colyseus。

核心命题：**配置定义游戏，框架运行游戏，AI 可选地生成配置。** 框架游戏无关，所有游戏内容由 `game/` 下的 JSON 声明，人类或 AI 产出同一份结构化配置。

- 仓库：`git@github.com:WuRunBear/game_server_test.git`
- 包名：`game_server_test` (v0.1.0, ESM, private)
- Node >= 22, TypeScript ^5.8, pnpm 工作区

## 技术栈

| 类别 | 技术 |
|------|------|
| ECS | bitecs ^0.4 (legacy API, SoA 组件) |
| 网络 | @colyseus/core + @colyseus/ws-transport |
| Schema | @colyseus/schema (状态同步) + zod ^4 (配置校验) |
| 碰撞 | check2d ^9 (SAT 分离) |
| AI 行为树 | mistreevous ^4 |
| 日志 | winston ^3 |
| 测试 | vitest ^4 |
| 开发运行 | tsx ^4 (热重载), tsc-alias (路径别名) |

## 四层架构

```
tools/        ← AI/工具层 — 通过 framework 公共 API 操作框架（不进运行时）
src/          ← 游戏入口 — bootstrapFramework → 启动 Colyseus 服务
framework/    ← 框架核心 — 游戏无关，所有通用逻辑
game/         ← 游戏配置 — 纯 JSON：实体、行为、地图、规则、生成点
```

**依赖方向严格自上而下**：`tools → framework`、`src → framework`。`framework` 不反向依赖任何游戏代码或工具代码。`game/` 目录是数据（非 TS），由 `loadGameDefinition` 按路径加载。

## 目录结构与职责

### `framework/` — 框架核心（81 个 TS 文件，~5200 行）

```
framework/
├── index.ts                  # 公共 API barrel 导出
├── api.ts                    # 全局 register* 函数 + list* 函数（操作单例 registry）
├── world.ts                  # GameWorld 类型 + createGameWorld()
├── bootstrap.ts              # bootstrapFramework() — 创建并填充所有 registry（模块单例）
├── bootstrap/
│   ├── GameInstance.ts        # createGameInstance(gameDef) → { world, systems, step, spawnInitialEntities }
│   └── loadGameDefinition.ts  # 加载 game.json + zod 校验 + 引用完整性检查
├── components/                # ECS 组件（SoA）+ componentRegistry
│   ├── componentRegistry.ts  # 组件注册表: 名 → defineComponent
│   ├── registerBuiltin.ts    # 注册 21 个内置组件
│   ├── transform.ts, size.ts, physics.ts, combat.ts, ai.ts
│   ├── inventory.ts (AoS 例外), network.ts, timer.ts, tags.ts
├── systems/
│   ├── systemRegistry.ts     # 系统注册表 + buildSystems (拓扑排序, Kahn 算法)
│   ├── registerBuiltinSystems.ts  # 注册 8 个内置系统
│   ├── core/                 # physicsSystem, movementSystem, collisionSystem
│   └── gameplay/             # aiSystem, combatSystem, spawningSystem, inventorySystem, interactionSystem
├── entities/
│   ├── archetypeRegistry.ts  # 原型注册表: kind → ArchetypeSpec
│   ├── registerBuiltinArchetypes.ts  # 注册 player, villager
│   └── spawn.ts              # spawnEntity(world, archetype, componentRegistry, overrides)
├── ai/
│   ├── actionRegistry.ts     # 动作注册表: 名 → ActionFactory
│   ├── btFactory.ts          # 行为树工厂 (配置 → mistreevous 树)
│   ├── btRunner.ts           # stepBehaviourTree(instance, ctx)
│   ├── blackboard.ts         # 每实体黑板 (Map 数据)
│   ├── registerBuiltinActions.ts  # 注册 Idle, Wander
│   └── nodes/actions/        # idle.ts, wander.ts
├── map/
│   ├── types.ts              # MapRuntime / MapSource / MapZone / Vec2
│   ├── tiled.ts             # Tiled JSON 解析 (collision/objects/zones 三层)
│   ├── buildRuntime.ts      # 纯函数: MapSource → MapRuntime
│   ├── generatorRegistry.ts # 生成器注册表: id → MapGenerator
│   ├── generated/simple.ts  # 默认程序化地图生成器 (xorshift32 RNG)
│   └── exportGenerated.ts   # MapRuntime → JSON + PNG (手写 PNG 编码器)
├── config/
│   ├── server.ts, game.ts, map.ts  # 静态配置
│   └── schema/               # zod schema: GameDefinition, Archetype, Behavior, Spawn, MapRegistry, Rule
├── net/
│   ├── colyseus/
│   │   ├── server.ts         # startColyseusServer — HTTP + WebSocket + /health /maps/runtime /debug/colliders
│   │   ├── rooms/GameRoom.ts # 房间: 持有 GameInstance，委托 step（只做传输/输入/同步/调试）
│   │   └── state/            # RoomState, PlayerState, EntityState (Colyseus Schema)
│   └── headless/
│       └── HeadlessHost.ts   # runHeadless(instance, opts) — 无传输驱动 step (测试/单机)
├── utils/                    # logger.ts (winston), timer.ts (clampMs)
├── metrics.ts                # tick 性能指标 (EMA avg)
├── repository.ts             # Repository 接口 (持久化抽象)
├── postgres.ts, redis.ts    # 占位 stub
└── __tests__/framework.test.ts  # 35 个测试, 17 个 describe 块
```

### `src/` — 游戏入口（3 个文件，~19 行）

| 文件 | 职责 |
|------|------|
| `index.ts` | 进程入口：`dotenv/config` → `main()` |
| `main.ts` | `bootstrapFramework()` → `startColyseusServer({ gameJsonPath: process.env.GAME_CONFIG_PATH })` |
| `register.ts` | 扩展注册入口（当前仅调用 `bootstrapFramework()`，无自定义扩展） |

**当前游戏 100% 依赖框架内置**：无自定义组件/系统/动作/生成器/规则。所有游戏内容来自 `game/*.json`。

### `game/` — 游戏配置（7 个 JSON 文件）

定义了一个游戏 `survival-island`（荒岛求生）：

| 文件 | 内容 |
|------|------|
| `game.json` | GameDefinition 主入口：tickRate=20, 8 个系统, netSync 配置 |
| `entities/player.json` | 玩家原型：box collider, Health 100, team 1, 无 behavior |
| `entities/villager.json` | 村民原型：box collider, Health 50, team 0, behavior=wander-default |
| `behaviors/wander-default.json` | 行为树：Root → Wander(speed=48) |
| `rules/combat.json` | 战斗规则：friendlyFire=false, standard 伤害公式, 1s 攻击冷却 |
| `spawns/populations.json` | 生成规则：villager 在 zone 1, max 5, 30s 重生 |
| `maps/registry.json` | 地图清单：generated-map, generatorId=simple, 64x64, seed=1 |

### `tools/` — CLI 工具层（6 个文件）

| 命令 | 文件 | 说明 |
|------|------|------|
| `pnpm tools validate` | validate.ts | 校验 game/ 下所有配置 |
| `pnpm tools new-game --id X` | new-game.ts | 脚手架生成 game/ + src/ 骨架（唯一不依赖 framework 的工具） |
| `pnpm tools list-registries` | list-registries.ts | 列出已注册的组件/系统/动作/原型/生成器 |
| `pnpm tools gen-map <id> --out <dir>` | gen-map.ts | 调用生成器产出地图 JSON+PNG |
| `pnpm tools export-map [mapId] --out <dir>` | export-map.ts | 导出 MapRuntime 为 JSON+PNG |

## 核心运行机制

### 启动流程

```
src/index.ts → dotenv → src/main.ts
  → bootstrapFramework()           # 创建 5 个 registry, 注册所有内置项 (幂等单例)
  → startColyseusServer(gameJsonPath)
    → loadGameDefinition(game/game.json)  # zod 校验 + 引用完整性检查
    → createGameInstance(gameDef)         # 装配 world + systems + map + spawnInitialEntities
    → GameRoom.setSimulationInterval      # 每 tick 驱动 gameInstance.step(dtMs)
```

### 游戏循环（每 tick）

1. `GameRoom` 接收客户端输入 → 写入 `Velocity` 组件
2. `gameInstance.step(dtMs)` — 系统按拓扑排序执行：
   - `aiSystem` → `physicsSystem` → `movementSystem` → `collisionSystem`
   - → `combatSystem` → `spawningSystem` → `inventorySystem` → `interactionSystem`
3. `syncState()` — 从 ECS 拉取状态写入 Colyseus `RoomState`（由 `gameDef.netSync.fields` 驱动）
4. 调试快照推送（节流 500ms）

### Registry 模式

所有扩展点（组件/系统/动作/原型/生成器/规则）使用统一的注册表模式：

| Registry | Key | Value | 内置注册数 |
|----------|-----|-------|-----------|
| componentRegistry | 组件名 | bitecs 组件对象 | 21 |
| systemRegistry | 系统 id | SystemSpec (factory + after/before) | 8 |
| actionRegistry | 动作名 | ActionFactory | 2 (Idle, Wander) |
| archetypeRegistry | kind | ArchetypeSpec (components, tags, behavior, team) | 2 (player, villager) |
| generatorRegistry | 生成器 id | MapGenerator 函数 | 1 (simple) |
| ruleRegistry (内联于 api.ts) | 规则 id | RuleModule 函数 | 0 (游戏自定义) |

注册表生命周期：`bootstrapFramework()` 创建（幂等，模块单例）→ `getRegistries()` 获取 → `createGameInstance()` 挂载到 `world` → 系统运行时通过 `world` 访问。

### ECS 组件清单

**SoA 组件**（bitecs defineComponent，按实体 id 索引）：
- 空间：`Transform` (x,y,rot,scale), `Size` (w,h)
- 物理：`Velocity` (vx,vy), `Acceleration` (ax,ay), `Collider` (shape,radius,halfW,halfH)
- 战斗：`Health` (current,max), `Attack` (value), `Defense` (value), `Team` (id)
- AI：`AIState` (state), `Target` (entity), `BlackboardRef` (id)
- 网络：`NetworkId` (value), `LastSynced` (tick)
- 计时：`Cooldown` (remainingMs), `Duration` (remainingMs)
- 标签：`Player`, `Enemy`, `NPC`, `Item` (空组件，存在性标记)

**AoS 例外**：`Inventory` 是普通 JS 数组（槽位数据是复合结构）。

### 系统运行时上下文

每个需要 per-world 可变状态的系统将状态存储在 `world.systemRuntimes: Map<string, unknown>` 中，使用固定 key：
- `"collision"` — check2d 系统实例 + 实体 body 映射
- `"ai"` — 行为树实例缓存 + 黑板 + eid→kind 映射
- `"spawning"` — 生成计时器

### 网络同步

- **服务端权威**：ECS world 是唯一真相源，`RoomState` 是每 tick 重新派生的视图
- **配置驱动同步字段**：`EntityState.values` 是 `MapSchema<number>`，key 格式 `"ComponentName.fieldName"`，由 `gameDef.netSync.fields` 配置，无硬编码字段
- **输入处理**：客户端发送 `{seq, moveX, moveY}`，服务端按 seq 去重，写入 `Velocity`
- **NetworkId**：通过 `world.nextNetworkId++` 分配稳定 id（不再等于 eid），作为 `RoomState.entities` 的 key

### 仿真/传输解耦

`GameInstance` 是纯仿真抽象。两种宿主：
- `GameRoom`（Colyseus）— 多人在线，传输 + 输入 + 同步 + 调试
- `HeadlessHost`（`runHeadless`）— 无传输，测试/单机，直接驱动 `instance.step()`

两者调用相同的 `gameInstance.step(dtMs)`，逻辑完全一致。

## 扩展指南

### 注册扩展（`src/register.ts`）

```ts
import {
  registerSystem, registerComponent, registerAction,
  registerGenerator, registerRuleModule, registerArchetype,
} from "framework";

registerComponent("Hunger", Hunger);
registerSystem({ id: "hunger", factory: (world) => hungerSystem(world), after: ["combat"] });
registerAction("Flee", createFleeAction);
registerGenerator("dungeon", generateDungeon);
registerRuleModule("damage-formula", customDamageFormula);
registerArchetype({ kind: "boar", tags: ["NPC","Enemy"], components: {...}, behavior: "boar-wander", team: 2 });
```

### 配置实体（`game/entities/boar.json`）

```json
{
  "kind": "boar",
  "tags": ["NPC", "Enemy"],
  "components": { "Health": { "max": 60 }, "Collider": { "shape": "circle", "radius": 8 } },
  "behavior": "boar-wander",
  "team": 2
}
```

### 扩展点总览

| 扩展点 | 注册函数 | 配置中引用 |
|--------|---------|-----------|
| System | `registerSystem()` | `game.json` 的 `systems[].id` |
| Component | `registerComponent()` | `entities/*.json` 的 `components` 块 |
| Action | `registerAction()` | `behaviors/*.json` 的 `action.name` |
| RuleModule | `registerRuleModule()` | `rules/*.json` 的 `xxxRef` 字段 |
| Generator | `registerGenerator()` | `maps/registry.json` 的 `generatorId` |
| Archetype | 自动加载 | `entities/*.json` |

### 扩展硬边界

- 禁止：直接修改 framework 源码、修改 GameWorld 核心结构、绕过 network layer 发消息、在系统里做异步 I/O
- 替换内置系统：注册同名替代 + 在 `game.json` 中启用新系统、停用旧系统

## 测试

- **35 个测试**，17 个 `describe` 块，位于 `framework/__tests__/framework.test.ts`
- `vitest.config.ts` 仅包含 `framework/__tests__/**/*.test.ts`
- `tests/shim/invalid-game.json` 是故意损坏的 JSON 负面测试夹具
- 测试模式：
  - Registry 边界测试（注册/查询/重复抛错/缺失抛错）
  - 系统单元测试（spawn 实体 → 取系统 factory → 调用 → 断言组件状态）
  - 集成测试（`createGameInstance` + `instance.step` + 断言 tick）
  - 确定性快照测试（3 tick 后精确状态）

## 常用命令

```bash
pnpm install              # 安装依赖
pnpm dev                  # tsx 热重载开发 (默认端口 3001, .env PORT 可覆盖)
pnpm build                # tsc 编译 + tsc-alias 路径重写
pnpm start                # 运行 dist/src/index.js
pnpm test                 # vitest run (35 个测试)
pnpm tools validate       # 校验 game/ 配置
pnpm tools list-registries  # 列出已注册项
pnpm tools gen-map simple --out out/  # 生成地图
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | 3001 | 服务监听端口 |
| `CORS_ORIGINS` | — | 跨域白名单（逗号分隔，空则允许 *） |
| `GAME_CONFIG_PATH` | `game/game.json` | 游戏配置路径 |

## 路径别名（tsconfig.json）

`framework` → `framework/index.ts`，以及 `components`, `systems`, `ai`, `map`, `config`, `network`, `utils`, `world`, `src` 等短别名。`tsc-alias` 在编译时重写为相对路径。

## 已知遗留/注意点

1. **ruleRegistry 实现 vs 文档**：`ARCHITECTURE.md` §6.7 描述了 `ruleRegistry.ts` 文件，但实际实现在 `framework/api.ts` 内联（私有 `Map`），功能等价但文件不存在。
2. **README 默认端口 3001 vs .env.example PORT=3000**：文档与示例不一致。
3. **`tests/` 目录名误导**：实际只有 1 个夹具文件，真正的测试在 `framework/__tests__/`。
4. **`.gitignore` 引用旧路径** `config/maps/exports/*`：当前导出路径在 `framework/map/`，但忽略规则仍生效。
5. **Repository/Postgres/Redis 全是 stub**：持久化层未实现。
6. **`interactionSystem` 是最小占位**：仅日志记录玩家靠近 NPC。
7. **Inventory 是 AoS**：与其他 20 个 SoA 组件不一致，如需扩展需注意。
