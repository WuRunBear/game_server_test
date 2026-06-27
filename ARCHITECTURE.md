# 架构方案：配置驱动的 2D 游戏服务端框架

本文档定义本项目从当前原型演进到「配置驱动、AI 可选、可快速生成不同 2D 游戏世界的服务端框架」的完整目标架构与改造方案。所有改造点都基于当前代码定位，不抽象悬空。

---

## 一、项目定位与核心命题

- **框架 = 运行和管理游戏**：游戏无关的运行时核心，不内置任何具体游戏知识。
- **配置 = 定义游戏内容**：一份 `GameDefinition`（JSON）完整描述一个游戏（世界观、地图、实体、行为、规则、系统启用、出生点）。
- **AI = 生成或辅助编辑配置的外部工具**：可选，框架对 AI 零依赖；人类可完全替代 AI 手写同样的配置。
- **核心命题**：配置定义游戏，框架运行游戏，AI 可选地生成配置。人和 AI 产出同一份结构化 JSON。

### 关键约束

- `framework/` **不得** import `src/` 或 `game/` 或 `tools/`（单向依赖，框架零游戏知识）。
- `src/` 通过 `import "./register"` 注册扩展，再调用 `framework` 启动游戏。
- `game/*.json` 只能由 `loadGameDefinition` 按路径加载，框架不硬编码任何游戏配置路径。
- `tools/` 只允许 import `framework`，不进运行时路径。
- 网络层是适配器：`GameInstance` 不依赖 Colyseus；`GameRoom` 只是 `GameInstance` 的一个宿主。

---

## 二、当前项目现状总结

### 2.1 已经具备的能力

| 能力 | 位置 | 评价 |
|---|---|---|
| bitecs ECS（SoA 组件 + AoS Inventory） | `src/components/*` | 结构清晰，10 个组件已定义 |
| 固定步长 tick 循环（20Hz） | `src/network/colyseus/rooms/GameRoom.ts:97` | 由 `setSimulationInterval` 驱动 |
| 物理积分（a→v→p） | `src/systems/core/physicsSystem.ts`、`movementSystem.ts` | 最小可用 |
| SAT 碰撞（圆/盒、实体-实体分离、实体-地图阻挡+速度清零） | `src/systems/core/collisionSystem.ts` | 完成度高，带调试快照 |
| 行为树（mistreevous）+ 黑板 + per-NPC 实例缓存 | `src/ai/*` | Idle/Wander 两个动作 |
| 地图：Tiled JSON 解析 + 程序生成 | `src/map/tiled.ts`、`generated/simple.ts` | 解析 `collision`/`objects`/`zones` 三层 |
| Colyseus 单房间 + 输入→Velocity + ECS→RoomState 同步 | `src/network/colyseus/*` | 服务端权威，NetworkId 做 key |
| 调试通道（`/debug/colliders` + 订阅推送） | `GameRoom.ts:261` | 可用 |
| 配置：端口/CORS、tickRate、地图清单读取 | `src/config/*` | 起步 |
| 实体工厂、Repository 接口、日志、指标 | `src/factories`、`database`、`utils`、`metrics.ts` | 占位/最小 |

### 2.2 现状的"半成品"特征

- `gameLoop.ts` 存在但未被使用（README 自承"当前不使用，由 GameRoom 驱动"）——存在两套循环驱动定义的残留。
- `inventorySystem`、`interactionSystem` 是空实现（`return world`）。
- `combatSystem` 只做"血量≤0 移除实体"，无伤害结算。
- `database/postgres.ts`、`redis.ts` 全是 stub。
- `config/maps.registry.json` 只注册了 `generated-map`。

### 2.3 已接近目标、可复用的部分

- `MapSource = Tiled | Generated` 联合类型（`src/map/types.ts:171`）是好的配置模型雏形。
- `tiled.ts` 的 `collision/objects/zones` 三层约定与 `assets/maps/Map/base.json` 实际结构吻合。
- `BtDefinitionJson`（`btFactory.ts:7`）已支持 JSON/文本两种输入。
- `collisionSystem` 的 `getCollisionDebugSnapshot` 是框架对外的"可观测 API"范例。
- 系统签名 `(world) => world` 纯函数约定（`world.ts:68`）良好。

---

## 三、当前架构冲突与设计风险

**冲突 A：GameRoom 是事实上的 GameInstance。**
`GameRoom.ts` 混了传输（Colyseus）、世界装配、系统编排、输入、同步、调试 6 件事。游戏逻辑无法脱离 Colyseus 运行，也无法换传输。这是迈向"通用框架"最大的结构性障碍。

**冲突 B：配置在调用点用全局 getter 现读。**
`getMapSourceFromConfig()`（`config/map.ts:139`）每次调用都 `fs.readFileSync("config/maps.registry.json")`，且被 `server.ts:84` 和 `GameRoom.ts:92` 各调一次。没有"加载一次的 GameDefinition 对象"，无法统一管理。

**冲突 C：`buildMapRuntime` 内嵌磁盘 I/O 副作用。**
`src/map/buildRuntime.ts:27` 在构建运行时地图时调用 `exportGeneratedMapArtifacts` 写 JSON+PNG。构建运行时本应纯函数；导出产物是工具职责。服务端每次启动都写盘，是职责越界。

**冲突 D：btFactory 把"动作实现"和"树定义"绑死。**
`createNpcTree`（`btFactory.ts:46-50`）里 agent 的 `Idle`/`Wander` 是硬编码方法引用。要加 `Patrol`/`Flee` 必须改 TS 并重新导出 `NpcBtAgent` 类型。配置驱动的 BT 需要"动作名→工厂函数"的注册表。

**冲突 E：`generatorId: "simple"` 是字面量联合类型。**
`src/map/types.ts:116` 把生成器 id 钉死成 `"simple"`。无法注册新生成器，扩展靠改类型。

**冲突 F：运行时状态挂载方式不一致。**
`collisionSystem` 用 `world as CollisionWorld` + 可选字段挂载（`collisionSystem.ts:86-88`）；`aiSystem` 用 `WeakMap` 挂载（`aiSystem.ts:24`）。两套模式并存，框架需要统一的"系统运行时上下文"约定。

**冲突 G：NetworkId = eid。**
`playerFactory.ts:68`、`npcFactory.ts:65` 都把 `NetworkId.value = eid`。实体复用可能让客户端绑定错乱。

**冲突 H：文档与代码漂移。**
README 提到的 `gameLoop.ts` 未使用。

---

## 四、目标架构：三层职责

```
┌─────────────────────────────────────────────────────────┐
│  AI / 工具层（可选、外部）                                │
│  tools/ 目录；通过 framework 公共 API 生成/校验配置       │
│  CLI + 公共 API：validate / new-game / list / gen-map    │
│  框架运行时零依赖此层                                    │
├─────────────────────────────────────────────────────────┤
│  配置层（game/，JSON）                                   │
│  game/game.json + entities/ + behaviors/ + rules/ +       │
│  spawns/ + maps/                                         │
│  由 zod schema 校验；人和 AI 产出同一份结构              │
├─────────────────────────────────────────────────────────┤
│  框架核心（framework/，TS）                              │
│  ECS + 系统 + 地图 + AI 运行时 + 网络适配 +              │
│  GameInstance 装配 + 配置加载与校验 + 各类 Registry       │
│  游戏无关；不 import src/ 或 game/ 或 tools/             │
├─────────────────────────────────────────────────────────┤
│  游戏代码（src/，TS）                                     │
│  入口 + register.ts + 游戏独有的系统/动作/规则/组件       │
│  通过 framework 公共 API 注册扩展                        │
└─────────────────────────────────────────────────────────┘
```

依赖方向严格自上而下：`tools → framework`、`src → framework`（注册扩展 + 启动）；`framework` 不反向依赖任何游戏代码或工具代码。

---

## 五、新目录结构

```
game_server_test/
│
├── framework/                              # 🟢 框架核心（独立目录，"像包一样"引入）
│   │
│   ├── index.ts                            # 公共 API 入口
│   │                                       # export { createGameInstance, loadGameDefinition,
│   │                                       #   registerSystem, registerComponent, registerAction,
│   │                                       #   registerRuleModule, registerGenerator, ... }
│   │
│   ├── world.ts                            # GameWorld 类型 + createGameWorld
│   │                                       # 扩展字段: gameDef, archetypes, systems_registry,
│   │                                       #   actions, generators, systemRuntimes, nextNetworkId
│   │
│   ├── components/                         # ECS 组件 + 组件注册表
│   │   ├── componentRegistry.ts            # 组件注册表: 组件名 → defineComponent 映射
│   │   ├── transform.ts
│   │   ├── size.ts
│   │   ├── physics.ts                      # Velocity / Acceleration / Collider / ColliderShape
│   │   ├── combat.ts                       # Health / Attack / Defense / Team
│   │   ├── ai.ts                           # AIState / Target / BlackboardRef
│   │   ├── inventory.ts
│   │   ├── network.ts                      # NetworkId / LastSynced
│   │   ├── timer.ts                        # Cooldown / Duration
│   │   └── tags.ts                         # Player / Enemy / NPC / Item
│   │
│   ├── systems/
│   │   ├── systemRegistry.ts               # 注册表: id → 工厂函数 + after/before/defaultOrder
│   │   │                                   # buildSystems(world, config) → 按配置过滤+拓扑排序
│   │   ├── core/
│   │   │   ├── physicsSystem.ts            # 加速度 → 速度
│   │   │   ├── movementSystem.ts           # 速度 → 位置
│   │   │   └── collisionSystem.ts          # check2d SAT: 分离 + 速度清零 + 调试快照
│   │   └── gameplay/
│   │       ├── aiSystem.ts                 # 行为树推进（per-NPC 实例缓存）
│   │       ├── combatSystem.ts             # 伤害结算 + 死亡清理（按规则配置）
│   │       ├── inventorySystem.ts          # 物品增删/容量/堆叠
│   │       ├── interactionSystem.ts        # 拾取/触发/对话
│   │       └── spawningSystem.ts           # 按种群/波次刷怪
│   │
│   ├── entities/
│   │   ├── archetypeRegistry.ts            # 注册表: kind → ArchetypeSpec
│   │   │                                   # ArchetypeSpec = { kind, tags, components, behavior, team }
│   │   └── spawn.ts                        # spawnEntity(world, kind, overrides)
│   │                                       # 流程: 查原型 → addEntity → 遍历 components 写入
│   │                                       #       → 分配 nextNetworkId → 若有 behavior 附加 AI 组件
│   │
│   ├── map/
│   │   ├── types.ts                        # MapRuntime / MapSource / MapZone / Vec2 / MapGrid / MapSpawns
│   │   ├── tiled.ts                        # Tiled JSON 解析 (collision/objects/zones 三层)
│   │   ├── buildRuntime.ts                 # 纯函数: MapSource → MapRuntime (查 generatorRegistry)
│   │   ├── generatorRegistry.ts            # 注册表: generatorId → MapGenerator 函数
│   │   └── generated/
│   │       └── simple.ts                   # 默认程序化地图生成器
│   │
│   ├── ai/
│   │   ├── blackboard.ts                   # 黑板: createBlackboard / bbSet / bbGet
│   │   ├── btRunner.ts                     # BtInstance 类型 + stepBehaviourTree
│   │   ├── btFactory.ts                    # createNpcTree(定义 + 查 actionRegistry) → BtInstance
│   │   ├── actionRegistry.ts              # 注册表: 动作名 → ActionFactory 函数
│   │   └── nodes/actions/
│   │       ├── idle.ts                     # Idle: 始终 SUCCEEDED
│   │       └── wander.ts                   # Wander: 随机方向游走 + 地图边界折返
│   │
│   ├── rules/
│   │   └── ruleRegistry.ts                 # 注册表: 规则模块 id → RuleModule
│   │
│   ├── bootstrap/
│   │   ├── GameInstance.ts                 # createGameInstance(gameDef) → { world, systems, step, spawnInitial }
│   │   └── loadGameDefinition.ts           # 读 + zod 校验 game.json 及所有子配置 → 强类型对象
│   │                                       # 校验引用完整性 (behavior/action/system/archetype)
│   │
│   ├── config/
│   │   └── schema/                         # zod schema（校验游戏配置）
│   │       ├── GameDefinitionSchema.ts
│   │       ├── ArchetypeSchema.ts
│   │       ├── MapRegistrySchema.ts
│   │       ├── BehaviorSchema.ts
│   │       └── RuleSchema.ts
│   │
│   ├── net/
│   │   ├── colyseus/                       # Colyseus 网络适配器
│   │   │   ├── server.ts                   # HTTP+WebSocket 启动 + /health /maps/runtime /debug/colliders
│   │   │   ├── rooms/
│   │   │   │   └── GameRoom.ts             # 房间（只做传输/输入/同步/调试，持有 GameInstance 委托 step）
│   │   │   └── state/
│   │   │       ├── RoomState.ts            # tick + players + entities (Colyseus Schema)
│   │   │       ├── PlayerState.ts          # sessionId + entityId
│   │   │       └── EntityState.ts          # 按 gameDef.netSync 可配置字段映射
│   │   └── headless/
│   │       └── HeadlessHost.ts             # 无传输驱动 GameInstance.step（测试/单机运行）
│   │
│   ├── utils/
│   │   ├── logger.ts                       # Winston 日志
│   │   └── timer.ts                        # clampMs 等工具
│   │
│   └── metrics.ts                          # tick 性能指标 (tickCount/lastTickMs/avgTickMs)
│
├── src/                                    # ⚪ 当前游戏项目的 TS 代码
│   │
│   ├── index.ts                            # 入口: dotenv/config → import "./register" → start()
│   ├── register.ts                         # 游戏独有扩展注册入口（副作用）
│   │                                       #   调用 registerSystem("hunger", ...)
│   │                                       #   调用 registerAction("Flee", ...)
│   │                                       #   调用 registerRuleModule("damage-formula", ...)
│   │                                       #   调用 registerComponent("Hunger", Hunger)
│   │                                       #   调用 registerGenerator("dungeon", ...)
│   ├── config/
│   │   └── server.ts                       # 读 .env → ServerConfig { port, corsOrigins, wsPath }
│   ├── components/                         # 游戏独有的 ECS 组件
│   │   └── hunger.ts
│   ├── systems/                            # 游戏独有的 ECS 系统
│   │   └── hungerSystem.ts
│   ├── actions/                            # 游戏独有的 AI 行为动作
│   │   └── flee.ts
│   └── formulas/                           # 游戏独有的规则公式
│       └── custom-damage.ts
│
├── game/                                   # 🔵 游戏配置（全部 JSON，TS 编译范围外）
│   │
│   ├── game.json                           # GameDefinition 主入口
│   ├── entities/                           # 实体原型定义
│   │   ├── player.json
│   │   ├── villager.json
│   │   └── boar.json
│   ├── behaviors/                          # 行为树定义
│   │   ├── idle.json
│   │   ├── wander.json
│   │   └── flee.json
│   ├── rules/                              # 规则参数
│   │   ├── combat.json
│   │   └── spawning.json
│   ├── spawns/                             # 出生点/种群
│   │   └── populations.json
│   └── maps/                               # 地图来源
│       ├── registry.json
│       └── island.tmx
│
├── tools/                                  # 🟡 AI/工具层（通过 framework 引用框架能力）
│   ├── cli.ts                              # 统一 CLI 入口
│   ├── validate.ts                         # 校验 game/ 目录下的所有配置
│   ├── gen-map.ts                          # 调用框架 generatorRegistry 产出地图 JSON+PNG
│   ├── export-map.ts                       # MapRuntime → JSON+PNG 磁盘导出
│   └── new-game.ts                         # 脚手架: 按模板生成 game/ + src/ 骨架
│
├── assets/                                 # 原始资源文件
│   └── maps/
├── logs/
├── dist/
│
├── .env / .env.example                     # PORT, CORS_ORIGINS
├── package.json
├── tsconfig.json                           # paths: "framework"→"./framework/index.ts"
│                                           # include: [src, tools, framework]
└── README.md
```

### tsconfig.json 关键配置

```jsonc
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "framework":    ["framework/index.ts"],
      "framework/*":  ["framework/*"]
    }
  },
  "include": ["src", "tools", "framework"]
}
```

---

## 六、框架核心内部设计

### 6.1 GameWorld（扩展）

在现有 `GameWorld`（`src/world.ts:43`）基础上挂载框架级注册表与系统运行时上下文：

```ts
export type GameWorld = ReturnType<typeof createWorld> & {
  time: GameTime;
  metrics: Metrics;
  logger: Logger;
  map?: MapRuntime;

  // 新增：配置与注册表
  gameDef: GameDefinition;
  archetypes: ArchetypeRegistry;
  systems_registry: SystemRegistry;
  actions: ActionRegistry;
  generators: GeneratorRegistry;
  components_registry: ComponentRegistry;

  // 新增：统一的系统运行时上下文（替代 collisionSystem 的 as CollisionWorld
  //       与 aiSystem 的 WeakMap 两套模式）
  systemRuntimes: Map<string, unknown>;

  // 新增：稳定的网络 id 分配器（替代 NetworkId = eid）
  nextNetworkId: number;
};
```

系统从 `world.gameDef` / `world.archetypes` / `world.actions` 读配置，不再走全局 getter。

### 6.2 componentRegistry（组件注册表）

把组件定义与注册表放在同一目录（`framework/components/`）：

```ts
// framework/components/componentRegistry.ts
export interface ComponentRegistry {
  register(name: string, component: unknown): void;
  get(name: string): unknown;
  all(): Record<string, unknown>;
}
```

实体原型 JSON 用组件名引用组件（如 `"Health": {"max": 60}`），`spawnEntity` 通过 registry 查到组件并 `addComponent` + 写入字段。

框架启动时注册内置 10 个组件；游戏通过 `registerComponent("Hunger", Hunger)` 注册自定义组件。

### 6.3 systemRegistry（系统注册表）

```ts
export interface SystemSpec {
  id: string;
  factory: (world: GameWorld) => System;
  after?: string[];
  before?: string[];
  defaultOrder?: number;
}

export function registerSystem(spec: SystemSpec): void;
export function buildSystems(world: GameWorld, enabled: SystemEnableEntry[]): System[];
```

`game.json` 的 `systems` 数组驱动启用与排序：

```jsonc
"systems": [
  { "id": "ai", "enabled": true },
  { "id": "physics" },
  { "id": "movement" },
  { "id": "collision" },
  { "id": "combat", "config": { "friendlyFire": false } },
  { "id": "hunger", "config": { "decayRate": 0.5 } }
]
```

`buildSystems` 按 `enabled` 过滤 + 按 `after/before/defaultOrder` 拓扑排序产出系统数组。系统可在 `world.gameDef.systems[i].config` 拿到自己的配置。

框架内置系统和游戏自定义系统在注册表中地位完全相同，只是"谁注册了谁"的区别。

### 6.4 archetypeRegistry + spawnEntity

替代 `playerFactory` 与 `npcFactory` 的硬编码工厂。`createNpc` 当前接收 `kind: string` 却完全不用（把所有 NPC 血量写死 50）——这是改造的核心痛点。

```ts
export interface ArchetypeSpec {
  kind: string;
  tags?: string[];
  components: Record<string, Record<string, unknown>>;
  behavior?: string;
  team?: number;
}

export function registerArchetype(spec: ArchetypeSpec): void;
export function getArchetype(kind: string): ArchetypeSpec;

export function spawnEntity(
  world: GameWorld,
  kind: string,
  overrides?: { x?: number; y?: number; [k: string]: unknown }
): EntityId;
```

`spawnEntity` 流程：
1. `getArchetype(kind)` 拿原型 spec。
2. `addEntity` + 遍历 `spec.components`，通过 `componentRegistry` 查组件并 `addComponent`，按 spec 字段值写入。
3. 写 `Transform.x/y`（来自 overrides）。
4. 分配稳定 `NetworkId`（`world.nextNetworkId++`，替代 `NetworkId.value = eid`）。
5. 若 `spec.behavior` 存在，附加 `AIState`/`BlackboardRef` 等组件，BT 实例由 `aiSystem` 按 `behavior` id 懒创建。

`player`/`villager`/`boar` 都变成 `game/entities/*.json` 配置，不再写死在 TS。

### 6.5 actionRegistry + btFactory（行为配置化）

```ts
export type ActionFactory = (args?: Record<string, unknown>) => () => State;
export function registerAction(name: string, factory: ActionFactory): void;
export function getAction(name: string): ActionFactory;
```

`btFactory.createNpcTree(definition)` 改为：
1. 解析 `definition`（JSON 或文本，复用现有 `parseJsonIfLooksLikeJson`）。
2. 扫描定义中引用的所有 action 名，从 `actionRegistry` 查工厂。
3. 用查到的 action 函数构造 agent 对象（动态属性，不再硬编码 `NpcBtAgent` 接口）。
4. 若有未注册的动作名，**fail fast** 抛错（在 `loadGameDefinition` 时就校验，不等到运行时静默失败）。

`registerAction("Idle", createIdleAction)` 与 `registerAction("Wander", createWanderAction)` 在框架启动时注册；游戏通过 `src/register.ts` 注册自定义动作。

### 6.6 generatorRegistry（地图生成器注册表）

放开 `src/map/types.ts:116` 的 `generatorId: "simple"` 字面量类型为 `string`：

```ts
export type MapGenerator = (opts: Record<string, unknown>) => MapRuntime;
export function registerGenerator(id: string, gen: MapGenerator): void;
export function getGenerator(id: string): MapGenerator;
```

`buildMapRuntime` 根据 `source.generatorId` 从 registry 查生成器，传 `source` 参数执行。`simple` 注册为默认生成器；游戏可注册自己的生成器（如 `dungeon`、`island`）。

地图生成算法本身在 `framework/map/generated/` 中（运行时调用），工具层 `tools/gen-map.ts` 只是对框架注册的生成器提供 CLI 包装。

### 6.7 ruleRegistry（规则模块注册表）

```ts
export function registerRuleModule(id: string, module: RuleModule): void;
```

`combatSystem` 改为从 `world.gameDef.rules.combat` 读伤害公式/友伤开关。JSON 表达不了的复杂公式，游戏可注册自定义规则模块替代。

### 6.8 GameInstance（装配抽象）

把 `GameRoom.onCreate`（`GameRoom.ts:83-96`）里的装配逻辑抽出来，让游戏能脱离 Colyseus 运行：

```ts
export interface GameInstance {
  world: GameWorld;
  systems: System[];
  step(dtMs: number): void;
  spawnInitialEntities(): void;
}

export function createGameInstance(gameDef: GameDefinition): GameInstance;
```

`createGameInstance` 流程：
1. `createGameWorld(gameDef.tickRate)` 创建 world。
2. 把 `gameDef`、各 registry 挂到 `world`。
3. `buildSystems(world, gameDef.systems)` 产出系统数组。
4. `buildMapRuntime(world.gameDef.map)` 加载地图到 `world.map`。
5. `spawnInitialEntities`：遍历 `world.map.spawns.npcs`，按 `kind` 调 `spawnEntity`；玩家出生点记录待 `onJoin` 用。

`GameRoom` 改为持有一个 `GameInstance`，`step` 委托给它；`GameRoom` 只保留传输、输入路由、状态同步、调试四件事。

`HeadlessHost` 提供无传输驱动 `GameInstance.step` 的能力，用于测试和单机运行。

### 6.9 统一系统运行时上下文

消除冲突 F：`collisionSystem` 的 `world as CollisionWorld` 可选字段挂载与 `aiSystem` 的 `WeakMap` 挂载统一为 `world.systemRuntimes: Map<string, unknown>`。每个系统用固定 key（如 `"collision"`、`"ai"`）存取自己的运行时缓存。

### 6.10 网络适配层

`GameRoom` 职责收窄为：
- `onCreate`：`createGameInstance(loadGameDefinition(gameJsonPath))` + `setSimulationInterval`。
- `onJoin`/`onLeave`：`spawnEntity("player")` / 移除实体，维护 sessionId↔eid 映射。
- `step`：`applyInputs` → `gameInstance.step` → `syncState` → `pushDebug`。
- `syncState`：从 ECS 拉取写回 RoomState（保持现有 `NetworkId` 做 key 的策略）。

`EntityState` 增加可配置字段映射：按 `gameDef.netSync` 决定同步哪些组件字段，而不是写死 x/y/hp/shape/radius/w/h，避免协议锁定。

---

## 七、配置层完整模型（GameDefinition）

### 7.1 `game/game.json` 主入口

```jsonc
{
  "id": "survival-island",
  "name": "荒岛求生",
  "worldview": { "theme": "survival", "dayLengthSec": 600 },
  "tickRate": 20,
  "map": { "registry": "./maps/registry.json", "default": "island" },
  "systems": [
    { "id": "ai", "enabled": true },
    { "id": "physics" },
    { "id": "movement" },
    { "id": "collision" },
    { "id": "combat", "config": { "friendlyFire": false } },
    { "id": "spawning", "config": { "respawnMs": 30000 } },
    { "id": "hunger", "config": { "decayRate": 0.5, "starveDamage": 5 } }
  ],
  "entities": "./entities/*.json",
  "behaviors": "./behaviors/*.json",
  "rules": "./rules/*.json",
  "spawns": "./spawns/*.json",
  "netSync": {
    "fields": [
      { "component": "Transform", "fields": ["x", "y"] },
      { "component": "Health", "fields": ["current"] },
      { "component": "Collider", "fields": ["shape", "radius"] },
      { "component": "Size", "fields": ["w", "h"] },
      { "component": "Hunger", "fields": ["value"] }
    ]
  }
}
```

### 7.2 实体原型 `game/entities/boar.json`

```jsonc
{
  "kind": "boar",
  "tags": ["NPC", "Enemy"],
  "components": {
    "Transform": {},
    "Velocity": {},
    "Collider": { "shape": "circle", "radius": 8 },
    "Health": { "max": 60 },
    "Size": { "w": 16, "h": 16 }
  },
  "behavior": "boar-wander",
  "team": 2
}
```

### 7.3 行为树 `game/behaviors/boar-wander.json`

```jsonc
{
  "id": "boar-wander",
  "definition": {
    "type": "root",
    "children": [
      { "type": "action", "name": "Wander", "args": { "speed": 48 } }
    ]
  }
}
```

### 7.4 地图清单 `game/maps/registry.json`

```jsonc
{
  "default": "island",
  "maps": {
    "island": {
      "kind": "generated",
      "generatorId": "simple",
      "name": "荒岛",
      "seed": 1,
      "width": 64, "height": 64,
      "tileWidth": 16, "tileHeight": 16
    },
    "dungeon-1": {
      "kind": "tiled",
      "path": "./maps/dungeon-1.json"
    }
  }
}
```

### 7.5 规则 `game/rules/combat.json`

```jsonc
{
  "friendlyFire": false,
  "damageFormula": "standard",
  "attackCooldownMs": 1000
}
```

若需自定义伤害公式：
```jsonc
{
  "friendlyFire": false,
  "damageFormula": "custom",
  "damageFormulaRef": "damage-formula",
  "attackCooldownMs": 1000
}
```

### 7.6 种群 `game/spawns/populations.json`

```jsonc
{
  "rules": [
    { "kind": "boar", "zoneId": 1, "max": 5, "respawnMs": 30000 },
    { "kind": "villager", "zoneId": 2, "max": 3, "respawnMs": 0 }
  ]
}
```

### 7.7 校验

所有 JSON 由 `framework/config/schema/` 下的 zod schema 校验。`loadGameDefinition` 在加载时：
1. 校验 `game.json` 结构。
2. 加载并校验所有引用的子配置（entities/behaviors/rules/spawns/maps）。
3. 校验引用完整性：每个 `behavior` id 存在、每个 `archetype.behavior` 引用的行为存在、每个 behavior 引用的 action 在 `actionRegistry` 已注册、每个 `system.id` 在 `systemRegistry` 已注册、`netSync` 引用的组件在 `componentRegistry` 已注册。**fail fast**，不静默放行。

---

## 八、游戏独有扩展

### 8.1 扩展点总览

| 扩展点 | 注册函数 | 在 `register.ts` 中调用 | 在 `game.json` / 子配置中引用 |
|--------|---------|------------------------|---------------------------|
| **System** | `registerSystem()` | ✓ | `systems: [{ "id": "hunger" }]` |
| **Component** | `registerComponent()` | ✓ | `entities/*.json` 的 `components` 块 |
| **Action** | `registerAction()` | ✓ | `behaviors/*.json` 的 `action.name` |
| **RuleModule** | `registerRuleModule()` | ✓ | `rules/*.json` 的 `xxxRef` 字段 |
| **Generator** | `registerGenerator()` | ✓ | `maps/registry.json` 的 `generatorId` |
| **Archetype** | — | 无需注册（JSON 自动加载） | `entities/*.json` |
| **netSync** | — | 无需注册（JSON 配置） | `game.json` 的 `netSync.fields` |

### 8.2 `src/register.ts` 完整示例

```ts
import {
  registerSystem,
  registerComponent,
  registerAction,
  registerRuleModule,
  registerGenerator,
} from "framework";

import { Hunger } from "./components/hunger";
import { Sanity } from "./components/sanity";
import { hungerSystem } from "./systems/hungerSystem";
import { sanitySystem } from "./systems/sanitySystem";
import { createFleeAction } from "./actions/flee";
import { createPatrolAction } from "./actions/patrol";
import { customDamageFormula } from "./formulas/custom-damage";
import { generateDungeon } from "./map/dungeonGenerator";

// 注册自定义组件
registerComponent("Hunger", Hunger);
registerComponent("Sanity", Sanity);

// 注册自定义系统
registerSystem({
  id: "hunger",
  factory: (world) => hungerSystem(world),
  after: ["combat"],
});
registerSystem({
  id: "sanity",
  factory: (world) => sanitySystem(world),
  after: ["ai"],
});

// 注册自定义 AI 动作
registerAction("Flee", createFleeAction);
registerAction("Patrol", createPatrolAction);

// 注册自定义规则
registerRuleModule("damage-formula", customDamageFormula);

// 注册自定义地图生成器
registerGenerator("dungeon", generateDungeon);
```

### 8.3 扩展的硬边界

| 行为 | 原因 |
|------|------|
| 直接修改框架源码 | 框架目录不随游戏走 |
| 替换框架内置系统实现 | 注册表 id 唯一，重复注册抛错。但可在 `game.json` 中不启用内置系统，注册同名替代 |
| 修改 `GameWorld` 核心结构 | 类型在框架中定义，游戏只读 |
| 绕过 network layer 发消息 | `GameRoom` 不暴露给游戏代码 |
| 在系统里做异步 I/O | 系统约定为 `(world) => world` 纯函数，同步执行 |
| import `tools/` 或 `game/` JSON | 依赖方向不允许 |

### 8.4 替换内置系统的方式

框架不区分"内置"和"自定义"系统。若要完全替换碰撞系统：
1. 注册自己的系统 `registerSystem({ id: "my-collision", ... })`
2. 在 `game.json` 中不启用 `"collision"`，启用 `"my-collision"`

---

## 九、AI / 工具层

### 9.1 公共 API（`framework/index.ts`）

框架对外暴露的唯一入口，`tools/` 与外部 AI 都通过它访问框架能力：

```ts
export {
  createGameInstance,
  loadGameDefinition,
  validateGameDefinition,
  registerSystem, registerComponent, registerArchetype,
  registerAction, registerGenerator, registerRuleModule,
  listRegisteredSystems, listRegisteredArchetypes, listRegisteredActions,
  buildMapRuntime, exportMapRuntime,
  type GameDefinition, type ArchetypeSpec, type MapRuntime,
} from "...";
```

### 9.2 CLI

```bash
pnpm tools validate                   # 校验 game/ 目录下的所有配置
pnpm tools new-game                   # 脚手架: 生成 game/ + src/ 骨架
pnpm tools list-registries            # 列出框架已注册的原型/动作/系统
pnpm tools gen-map <generatorId> --out <path>   # 调用生成器产出地图 JSON
pnpm tools export-map <mapId> --out <dir>       # 把 MapRuntime 导出为 JSON+PNG
```

### 9.3 AI 集成约定

- AI 通过公共 API 生成/校验配置，不直接改框架代码。
- AI 的写入设计为"先生成到临时文件 → `validate` 校验通过 → 原子替换"，避免半截配置污染运行时。
- `game/` 目录纳入 git 版本控制，AI 改动可 diff、可回滚。
- 没有 AI 时，人手写 JSON 即可，框架完整可用。

---

## 十、分阶段实施方案

### 阶段 0：止血对齐

- 删除未使用的 `src/gameLoop.ts`（README 自承"当前不使用"），消除双循环歧义。
- 把 `exportGeneratedMapArtifacts` 从 `buildMapRuntime`（`src/map/buildRuntime.ts:27`）拆出，`buildMapRuntime` 变纯函数；导出功能移到 `tools/export-map.ts`。
- 给 `tsconfig.json` 的 `paths` 补 `framework/*` 别名，`include` 补 `framework`。
- 引入 `zod` 和 `vitest` 依赖。

### 阶段 1：MVP — 配置驱动基础

1. **GameDefinition Schema + 加载**：在 `framework/config/schema/` 定义 zod schema；实现 `loadGameDefinition`。
2. **World 扩展 + Registry 基础**：扩展 `GameWorld` 挂载 `gameDef`、各 registry、`systemRuntimes`、`nextNetworkId`；建立 `componentRegistry`，注册现有 10 个组件。
3. **GameInstance 抽象**：实现 `createGameInstance`，把 `GameRoom.onCreate` 的装配逻辑搬过来；`GameRoom` 改为持有 `GameInstance` 委托 `step`；实现 `HeadlessHost`。
4. **systemRegistry**：注册现有 7 个系统；`createSystems()` 改为 `buildSystems(world, gameDef.systems)`；统一运行时挂载为 `world.systemRuntimes`。
5. **archetypeRegistry + spawnEntity**：把 `playerFactory`/`npcFactory` 改写为注册原型 + 通用 `spawnEntity`；让 `kind` 真正生效；`NetworkId.value` 改为 `world.nextNetworkId++`。
6. **actionRegistry + btFactory 配置化**：注册 `Idle`/`Wander`；改造 `btFactory` 从 registry 查动作。
7. **generatorRegistry**：注册 `simple`；`MapSource.generatorId` 放开为 `string`。
8. **MVP 验证**：在 `game/` 下创建最小 `game.json`（等价于当前原型功能）；写 vitest 测试 headless 跑 N tick；确保现有 `pnpm dev` 仍能启动。

### 阶段 2：配置层完善 + 网络层适配

- 完善 zod schema：`BehaviorSchema`、`RuleSchema`、`SpawnSchema`。
- `loadGameDefinition` 增加引用完整性校验（fail fast）。
- `combatSystem` 改为从 `gameDef.rules.combat` 读参数，实现伤害结算。
- 新增 `spawningSystem`，从 `gameDef.spawns` 读种群规则。
- 补 `inventorySystem`/`interactionSystem` 最小实现。
- `EntityState` 增加可配置字段映射（按 `gameDef.netSync`）。
- `server.ts` 支持 `gameJsonPath` 参数。

### 阶段 3：AI/工具层 + 测试加固

- 实现 `framework/index.ts` 公共 API 导出。
- 实现 `tools/{validate,new-game,list-registries,gen-map,export-map,cli}.ts`。
- 完善测试覆盖：`archetypeRegistry`、`systemRegistry`、`actionRegistry`、`GameInstance.step` 快照测试。
- 更新 `README.md`。

### 阶段 4：目录结构重整 + 扩展点完善

- 物理搬移文件到 `framework/`、`src/`、`game/`、`tools/` 目录。
- 删除旧路径兼容导出。
- 补充 `registerComponent` 等扩展 API 到公共入口。
- 建立多游戏示例项目验证框架通用性（独立仓库）。

---

## 十一、架构风险

1. **最大风险：做了配置 schema 却不抽 GameInstance。** 如果只加配置却让 `GameRoom` 继续直接装配，配置对象会通过全局 getter 散落各处。**`gameDef` 必须挂到 `GameWorld` 上，`GameInstance` 抽象必须落地**。

2. **schema 演进风险。** 配置一旦被 AI/人广泛使用，schema 变更成本陡增。**schema 字段要尽量少且正交**，宁可后加，不要先写死易变的字段。

3. **"配置能表达一切"的诱惑。** 一定会有逻辑用 JSON 表达不优雅。**必须保留 `src/register.ts` + 游戏独有代码作为逃生口**，否则框架会被迫把图灵完备塞进 JSON。

4. **btFactory 配置化的安全边界。** AI 生成的行为树可能引用未注册的动作名。`actionRegistry` 必须在 `loadGameDefinition` 时校验所有 behavior 引用的动作都已注册，**fail fast**。

5. **Colyseus Schema 字段写死的风险。** `EntityState` 当前写死 x/y/hp/shape/radius/w/h。**可配置字段映射要尽早设计，避免协议锁定。**

6. **测试缺失会让配置驱动退化。** 配置驱动的核心承诺是"相同配置→相同运行"。没有 `GameInstance` 的 headless 快照测试，重构和 AI 生成都无安全网。**测试必须与改造同步引入。**

7. **NetworkId 与 eid 分离的兼容期。** `NetworkId.value = eid` 改掉后，客户端的实体映射逻辑要同步更新。过渡期可在 `world.nextNetworkId` 初值上做兼容，但最终必须完全分离。

8. **bitecs/legacy API 兼容性。** 项目用 `bitecs/legacy` 的 `defineComponent`，类型声明是手工写的。一旦升级 bitecs 或切换到非 legacy API，组件访问方式可能全盘失效。建议在阶段 1 就规范化组件访问方式。

9. **Inventory 组件 AoS 不一致。** `Inventory` 是普通 `[]` 而非 `defineComponent`，与其他 9 个组件不一致。如果 `inventorySystem` 未来要实现，这种不一致会造成困惑。