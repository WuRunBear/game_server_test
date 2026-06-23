# 架构方案：配置驱动的 2D 游戏服务端框架

本文档定义本项目从当前原型演进到「配置驱动、AI 可选、可快速生成不同 2D 游戏世界的服务端框架」的完整目标架构与改造方案。所有改造点都基于当前代码定位，不抽象悬空。

---

## 一、项目定位与核心命题

- **框架 = 运行和管理游戏**：游戏无关的运行时核心，不内置任何具体游戏知识。
- **配置 = 定义游戏内容**：一份 `GameDefinition`（JSON）完整描述一个游戏（世界观、地图、实体、行为、规则、系统启用、出生点）。
- **AI = 生成或辅助编辑配置的外部工具**：可选，框架对 AI 零依赖；人类可完全替代 AI 手写同样的配置。
- **核心命题**：配置定义游戏，框架运行游戏，AI 可选地生成配置。人和 AI 产出同一份结构化 JSON。

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

- `ARCHITECTURE.md` 此前是空文件；`gameLoop.ts` 存在但未被使用（README 自承"当前不使用，由 GameRoom 驱动"）——存在两套循环驱动定义的残留。
- `inventorySystem`、`interactionSystem` 是空实现（`return world`）。
- `combatSystem` 只做"血量≤0 移除实体"，无伤害结算。
- `database/postgres.ts`、`redis.ts` 全是 stub。
- `config/maps.registry.json` 只注册了 `generated-map`，但 `config/maps/exports/` 里还躺着一份 `survival.json`（荒岛求生，含 villager/boar 出生点）——有内容没接进运行时。

### 2.3 已接近目标、可复用的部分

- `MapSource = Tiled | Generated` 联合类型（`src/map/types.ts:171`）是好的配置模型雏形。
- `tiled.ts` 的 `collision/objects/zones` 三层约定与 `assets/maps/Map/base.json` 实际结构吻合（第 330/341/352 行）。
- `BtDefinitionJson`（`btFactory.ts:7`）已支持 JSON/文本两种输入。
- `collisionSystem` 的 `getCollisionDebugSnapshot` 是框架对外的"可观测 API"范例。
- 系统签名 `(world) => world` 纯函数约定（`world.ts:68`）良好。

---

## 三、当前架构冲突与设计风险（直接指出）

**冲突 A：GameRoom 是事实上的 GameInstance。**
`GameRoom.ts` 混了传输（Colyseus）、世界装配、系统编排、输入、同步、调试 6 件事。游戏逻辑无法脱离 Colyseus 运行，也无法换传输。这是迈向"通用框架"最大的结构性障碍。

**冲突 B：配置在调用点用全局 getter 现读。**
`getMapSourceFromConfig()`（`config/map.ts:139`）每次调用都 `fs.readFileSync("config/maps.registry.json")`，且被 `server.ts:84` 和 `GameRoom.ts:92` 各调一次。没有"加载一次的 GameDefinition 对象"，无法多游戏共存。

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
README 提到的 `gameLoop.ts` 未使用；`survival.json` 导出物未进 registry。文档/代码/配置三者不一致。

---

## 四、目标架构：三层职责

```
┌─────────────────────────────────────────────────────────┐
│  AI / 工具层（可选、外部）                                │
│  生成/校验 GameDefinition；不参与运行时                   │
│  CLI + 公共 API：validate / new-game / list / gen-map    │
├─────────────────────────────────────────────────────────┤
│  配置层（GameDefinition，JSON）                           │
│  定义：世界观/地图引用/实体原型/行为/规则/系统启用与排序/  │
│        出生点与种群/物品与交互                            │
│  由 zod schema 校验；人和 AI 产出同一份结构               │
├─────────────────────────────────────────────────────────┤
│  框架核心（运行时，TS）                                    │
│  ECS + 系统 + 地图 + AI 运行时 + 网络适配 +              │
│  GameInstance 装配 + 配置加载与校验 + 各类 Registry       │
│  游戏无关；不 import games/ 或 tools/                    │
└─────────────────────────────────────────────────────────┘
```

依赖方向严格自上而下：`tools → framework`、`games → framework`（仅类型）；`framework` 不反向依赖任何游戏或工具代码。

---

## 五、新目录结构（完整目标态）

```
src/
  framework/                           # 框架核心（游戏无关）
    ecs/
      world.ts                         # GameWorld、EntityId、System 类型
      componentRegistry.ts             # 组件名 → defineComponent 映射
    systems/
      systemRegistry.ts                # id → system 工厂，含依赖/排序元数据
      core/
        physicsSystem.ts
        movementSystem.ts
        collisionSystem.ts
      gameplay/
        aiSystem.ts
        combatSystem.ts
        inventorySystem.ts
        interactionSystem.ts
        spawningSystem.ts              # 新增：按种群/波次刷怪
    entities/
      archetypeRegistry.ts             # kind → ArchetypeSpec + spawnEntity
      spawn.ts                         # 通用实体生成（替代旧 factories/）
    map/
      types.ts
      tiled.ts
      buildRuntime.ts                  # 纯函数，无磁盘副作用
      generatorRegistry.ts             # generatorId → 生成器
      generated/simple.ts
    ai/
      blackboard.ts
      btRunner.ts
      btFactory.ts                     # 从配置 + 动作注册表构建
      actionRegistry.ts                # 动作名 → 工厂
      nodes/actions/
        idle.ts
        wander.ts
        (patrol.ts、flee.ts ...)
    rules/
      ruleRegistry.ts                  # 规则模块注册
      combat.ts                        # 伤害公式/友伤
      spawning.ts                      # 刷怪规则参数
    bootstrap/
      GameInstance.ts                  # 输入 GameDefinition → 输出 {world, systems, step, spawnInitial}
      loadGameDefinition.ts            # 读 + 校验 JSON → 强类型对象
    config/
      schema/                          # zod schema
        GameDefinitionSchema.ts
        ArchetypeSchema.ts
        MapRegistrySchema.ts
        BehaviorSchema.ts
        RuleSchema.ts
      loader.ts
    net/
      colyseus/
        server.ts
        rooms/GameRoom.ts              # 只做传输/输入/同步/调试，委托 GameInstance
        state/{RoomState,EntityState,PlayerState}.ts
      headless/
        HeadlessHost.ts                # 无传输驱动 GameInstance.step（测试/单机）
    utils/
      logger.ts
      timer.ts
    metrics.ts
    public-api.ts                      # 框架对外公共 API（tools/AI 的唯一入口）

  games/                               # 配置层（每个游戏一个目录）
    <game-id>/
      game.json                        # GameDefinition 主入口
      maps/
        registry.json
        <map-id>.json                  # Tiled 引用或 generated 参数
      entities/
        player.json
        villager.json
        boar.json
        ...
      behaviors/
        villager-idle.json
        boar-wander.json
        ...
      rules/
        combat.json
        spawning.json
      spawns/
        waves.json
        populations.json
      overrides/                       # 可选：配置表达不了的硬编码扩展
        *.ts

  tools/                               # AI/工具层（可选，框架不依赖）
    validate.ts                        # 校验一份 GameDefinition
    new-game.ts                        # 脚手架生成空游戏骨架
    list-archetypes.ts                 # 列出框架已注册的原型/动作/系统
    gen-map.ts                         # 调用生成器产出地图 JSON
    export-map.ts                      # 把 MapRuntime 导出为 JSON+PNG
    cli.ts                             # 统一 CLI 入口
```

### 关键边界（强制约束）

- `src/framework/` **不得** import `src/games/` 或 `src/tools/`（单向依赖，框架零游戏知识）。
- `src/games/<id>/*.json` **不得**被框架硬编码引用——只能由 `loadGameDefinition(gameId)` 按参数加载。
- `src/tools/` **只允许** import `src/framework/public-api.ts`，不进运行时路径。
- **网络层是适配器**：`GameInstance` 不依赖 Colyseus；`GameRoom` 只是 `GameInstance` 的一个宿主。
- 框架运行时永不 import `tools/`。

### 过渡策略：不立即搬文件

上述目录是最终态。过渡期不要一次性重命名/搬移已有文件，而是：

1. 在 `src/framework/` 下新建子模块（`entities/archetypeRegistry.ts`、`systems/systemRegistry.ts` 等）。
2. 旧文件（`src/factories/`、`src/systems/index.ts`）**逐步委托给新模块**，保留原路径导出兼容。
3. 一旦旧文件的所有 import 者都改用了新路径，再物理删除/合并。

---

## 六、框架核心内部设计

### 6.1 GameWorld（扩展）

在 `src/world.ts:43` 现有 `GameWorld` 基础上挂载框架级注册表与系统运行时上下文：

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

  // 新增：统一的系统运行时上下文（替代 collisionSystem 的 as CollisionWorld
  //       与 aiSystem 的 WeakMap 两套模式）
  systemRuntimes: Map<string, unknown>;

  // 新增：稳定的网络 id 分配器（替代 NetworkId = eid）
  nextNetworkId: number;
};
```

系统从 `world.gameDef` / `world.archetypes` / `world.actions` 读配置，不再走全局 getter。

### 6.2 componentRegistry（组件注册表）

把 `src/components/index.ts` 的硬编码导出改为注册式：

```ts
// framework/ecs/componentRegistry.ts
export interface ComponentRegistry {
  register(name: string, component: unknown): void;
  get(name: string): unknown;
  all(): Record<string, unknown>;
}
```

实体原型 JSON 用组件名引用组件（如 `"Health": {"max": 60}`），`spawnEntity` 通过 registry 查到组件并 `addComponent` + 写入字段。

### 6.3 systemRegistry（系统注册表）

替代 `src/systems/index.ts:14-24` 写死的 `createSystems()`：

```ts
// framework/systems/systemRegistry.ts
export interface SystemSpec {
  id: string;
  factory: (world: GameWorld) => System;
  // 可选：声明依赖与默认排序权重
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
  { "id": "spawning", "config": { "respawnMs": 30000 } }
]
```

`buildSystems` 按 `enabled` 过滤 + 按 `after/before/defaultOrder` 拓扑排序产出系统数组。系统可在 `world.gameDef.systems[i].config` 拿到自己的配置。

### 6.4 archetypeRegistry + spawnEntity（实体原型）

替代 `src/factories/playerFactory.ts` 与 `npcFactory.ts` 的硬编码工厂。`createNpc` 当前接收 `kind: string` 却完全不用（`npcFactory.ts:62-63` 把所有 NPC 血量写死 50）——这是改造的核心痛点。

```ts
// framework/entities/archetypeRegistry.ts
export interface ArchetypeSpec {
  kind: string;
  tags?: string[];                    // ["Player","NPC","Enemy","Item"]
  components: Record<string, Record<string, unknown>>;
  behavior?: string;                  // 引用 behaviors/*.json 的 id
  team?: number;
}

export function registerArchetype(spec: ArchetypeSpec): void;
export function getArchetype(kind: string): ArchetypeSpec;

// framework/entities/spawn.ts
export function spawnEntity(
  world: GameWorld,
  kind: string,
  overrides?: { x?: number; y?: number; [k: string]: unknown }
): EntityId;
```

`spawnEntity` 流程：
1. `getArchetype(kind)` 拿原型 spec。
2. `addEntity` + 遍历 `spec.components`，通过 `componentRegistry` 查组件并 `addComponent`，按 spec 字段值写入（缺省值由组件自身默认）。
3. 写 `Transform.x/y`（来自 overrides）。
4. 分配稳定 `NetworkId`（`world.nextNetworkId++`，替代 `NetworkId.value = eid`）。
5. 若 `spec.behavior` 存在，附加 `AIState`/`BlackboardRef` 等组件，BT 实例由 `aiSystem` 按 `behavior` id 懒创建。

`player`/`npc`/`villager`/`boar` 都变成 `games/<id>/entities/*.json` 配置，不再写死在 TS。

### 6.5 actionRegistry + btFactory（行为配置化）

解除 `btFactory.ts:46-50` 把 `Idle`/`Wander` 硬编码为 agent 方法的耦合：

```ts
// framework/ai/actionRegistry.ts
export type ActionFactory = (args?: Record<string, unknown>) => () => State;
export function registerAction(name: string, factory: ActionFactory): void;
export function getAction(name: string): ActionFactory;
```

`btFactory.createNpcTree(definition, actionArgs)` 改为：
1. 解析 `definition`（JSON 或文本，复用现有 `parseJsonIfLooksLikeJson`）。
2. 扫描定义中引用的所有 action 名，从 `actionRegistry` 查工厂。
3. 用查到的 action 函数构造 agent 对象（动态属性，不再硬编码 `NpcBtAgent` 接口）。
4. 若有未注册的动作名，**fail fast** 抛错（在 `loadGameDefinition` 时就校验，不等到运行时静默失败）。

`registerAction("Idle", createIdleAction)` 与 `registerAction("Wander", createWanderAction)` 在框架启动时注册；游戏可通过 `overrides/*.ts` 注册自定义动作。

### 6.6 generatorRegistry（地图生成器注册表）

放开 `src/map/types.ts:116` 的 `generatorId: "simple"` 字面量类型为 `string`：

```ts
// framework/map/generatorRegistry.ts
export type MapGenerator = (opts: Record<string, unknown>) => MapRuntime;
export function registerGenerator(id: string, gen: MapGenerator): void;
export function getGenerator(id: string): MapGenerator;
```

`buildMapRuntime` 根据 `source.generatorId` 从 registry 查生成器，传 `source` 参数执行。`simple` 注册为默认生成器；新游戏可注册自己的生成器（如 `dungeon`、`island`）。

### 6.7 GameInstance（装配抽象）

把 `GameRoom.onCreate`（`GameRoom.ts:83-96`）里的装配逻辑抽出来，让游戏能脱离 Colyseus 运行：

```ts
// framework/bootstrap/GameInstance.ts
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

### 6.8 规则模块（ruleRegistry）

把硬编码规则参数外置到 `games/<id>/rules/*.json`：

```ts
// framework/rules/ruleRegistry.ts
export function registerRuleModule(id: string, module: RuleModule): void;
```

`combatSystem` 改为从 `world.gameDef.rules.combat` 读伤害公式/友伤开关；`Attack`/`Defense` 组件的初始值由实体原型配置。`spawningSystem` 从 `world.gameDef.rules.spawning` 读种群上限/复活时间/波次。

### 6.9 统一系统运行时上下文

消除冲突 F：`collisionSystem` 的 `world as CollisionWorld` 可选字段挂载（`collisionSystem.ts:86-88`）与 `aiSystem` 的 `WeakMap` 挂载（`aiSystem.ts:24`）统一为 `world.systemRuntimes: Map<string, unknown>`。每个系统用固定 key（如 `"collision"`、`"ai"`）存取自己的运行时缓存。

### 6.10 网络适配层

`GameRoom` 职责收窄为：
- `onCreate`：`createGameInstance(loadGameDefinition(gameId))` + `setSimulationInterval`。
- `onJoin`/`onLeave`：`spawnEntity("player")` / 移除实体，维护 sessionId↔eid 映射。
- `step`：`applyInputs` → `gameInstance.step` → `syncState` → `pushDebug`。
- `syncState`：从 ECS 拉取写回 RoomState（保持现有 `NetworkId` 做 key 的策略）。

新增 `EntityState` 可配置字段映射：按 `gameDef.netSync` 决定同步哪些组件字段，而不是写死 x/y/hp/shape/radius/w/h（`EntityState.ts`），避免协议锁定。

---

## 七、配置层完整模型（GameDefinition）

### 7.1 `game.json` 主入口

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
    { "id": "spawning", "config": { "respawnMs": 30000 } }
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
      { "component": "Size", "fields": ["w", "h"] }
    ]
  }
}
```

### 7.2 实体原型 `entities/boar.json`

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

### 7.3 行为树 `behaviors/boar-wander.json`

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

### 7.4 地图清单 `maps/registry.json`

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

### 7.5 规则 `rules/combat.json`

```jsonc
{
  "friendlyFire": false,
  "damageFormula": "max(attack.value - defense.value, 1)",
  "attackCooldownMs": 1000
}
```

### 7.6 种群 `spawns/populations.json`

```jsonc
{
  "rules": [
    { "kind": "boar", "zoneId": 1, "max": 5, "respawnMs": 30000 },
    { "kind": "villager", "zoneId": 2, "max": 3, "respawnMs": 0 }
  ]
}
```

### 7.7 校验

所有 JSON 由 `src/framework/config/schema/` 下的 zod schema 校验。`loadGameDefinition` 在加载时：
1. 校验 `game.json` 结构。
2. 加载并校验所有引用的子配置（entities/behaviors/rules/spawns/maps）。
3. 校验引用完整性：每个 `behavior` id 存在、每个 `archetype.behavior` 引用的行为存在、每个 behavior 引用的 action 在 `actionRegistry` 已注册、每个 `system.id` 在 `systemRegistry` 已注册。**fail fast**，不静默放行。

---

## 八、AI / 工具层完整设计

### 8.1 公共 API（`src/framework/public-api.ts`）

框架对外暴露的唯一入口，`tools/` 与外部 AI 都通过它访问框架能力：

```ts
export {
  createGameInstance,
  loadGameDefinition,
  validateGameDefinition,
  registerSystem, registerArchetype, registerAction, registerGenerator,
  listRegisteredSystems, listRegisteredArchetypes, listRegisteredActions,
  buildMapRuntime, exportMapRuntime,
  type GameDefinition, type ArchetypeSpec, type MapRuntime,
} from "...";
```

### 8.2 CLI（`src/tools/cli.ts`）

```bash
pnpm tools validate games/survival-island        # 校验一份 GameDefinition
pnpm tools new-game <id>                          # 生成空游戏骨架
pnpm tools list-archetypes                         # 列出框架已注册的原型/动作/系统
pnpm tools gen-map <generatorId> --out <path>     # 调用生成器产出地图 JSON
pnpm tools export-map <mapId> --out <dir>         # 把 MapRuntime 导出为 JSON+PNG
```

### 8.3 AI 集成约定

- AI 通过公共 API 生成/校验配置，不直接改框架代码。
- AI 的写入设计为"先生成到临时文件 → `validate` 校验通过 → 原子替换"，避免半截配置污染运行时。
- `games/` 目录纳入 git 版本控制，AI 改动可 diff、可回滚。
- 没有 AI 时，人手写 JSON 即可，框架完整可用。

---

## 九、具体改造点清单（基于当前代码定位）

以下是相对当前代码的具体修改，按模块组织，不分阶段：

### 9.1 止血与对齐

- 删除未使用的 `src/gameLoop.ts`（README 自承"当前不使用"），消除双循环歧义。
- 把 `exportGeneratedMapArtifacts` 从 `buildMapRuntime`（`src/map/buildRuntime.ts:27`）拆出，`buildMapRuntime` 变纯函数；导出功能移到 `tools/export-map.ts`。
- 把 `config/maps/exports/survival.json` 接进 `maps.registry.json` 或移出 `config/`，消除漂移。
- 给 `tsconfig.json` 的 `paths` 补 `framework/*`、`games/*`、`tools/*` 别名。

### 9.2 配置 schema 与加载

- 引入 `zod` 依赖。
- 在 `src/framework/config/schema/` 定义 `GameDefinitionSchema`、`ArchetypeSchema`、`MapRegistrySchema`、`BehaviorSchema`、`RuleSchema`、`SpawnSchema`。字段从最小集开始，覆盖现有能力。
- 实现 `loadGameDefinition(gameId)`：从 `games/<id>/game.json` 读取并校验，返回强类型对象。
- 在加载时校验引用完整性（behavior id / action 名 / system id / archetype 引用）。

### 9.3 ECS 与 World

- 实现 `componentRegistry`，把 `src/components/*` 注册进去。
- 扩展 `GameWorld`（`src/world.ts:43`）挂载 `gameDef`、`archetypes`、`systems_registry`、`actions`、`generators`、`systemRuntimes`、`nextNetworkId`。

### 9.4 实体原型

- 实现 `archetypeRegistry` + `spawnEntity`。
- 把 `playerFactory`/`npcFactory` 改写为"注册 `player`/`npc` 原型 + 通用 `spawnEntity`"。
- 让 `npcFactory.ts:62-63` 写死的血量 50 改为从原型配置读。
- 让 `kind`（从地图出生点 → GameRoom → 工厂一路传来却被丢弃）真正生效。
- `NetworkId.value` 改为 `world.nextNetworkId++`，不再等于 eid。

### 9.5 系统

- 实现 `systemRegistry`，把现有 7 个系统注册。
- `createSystems()`（`src/systems/index.ts:14`）改为 `buildSystems(world, gameDef.systems)`，按配置过滤+排序。
- 统一系统运行时挂载：`collisionSystem` 的 `as CollisionWorld`（`collisionSystem.ts:86`）与 `aiSystem` 的 `WeakMap`（`aiSystem.ts:24`）统一为 `world.systemRuntimes`。

### 9.6 AI 行为

- 实现 `actionRegistry`，注册 `Idle`/`Wander`。
- 改造 `btFactory.createNpcTree`：从 `actionRegistry` 查动作构造 agent，删除 `NpcBtAgent` 的硬编码方法（`btFactory.ts:46-50`）。
- `aiSystem` 按 `archetype.behavior` id 从 `gameDef.behaviors` 查 BT 定义创建实例。

### 9.7 地图

- 实现 `generatorRegistry`，注册 `simple`。
- `MapSource.generatorId`（`src/map/types.ts:116`）放开为 `string`。
- `buildMapRuntime` 变纯函数，按 `generatorId` 从 registry 查生成器。

### 9.8 GameInstance 装配

- 实现 `GameInstance` + `createGameInstance`。
- 把 `GameRoom.onCreate`（`GameRoom.ts:83-96`）的装配逻辑搬到 `createGameInstance`。
- `GameRoom` 改为持有 `GameInstance`，`step` 委托。
- 实现 `HeadlessHost` 用于无传输运行/测试。
- 替换 `getMapSourceFromConfig()` 全局 getter（`config/map.ts:139`）为从 `world.gameDef` 读。

### 9.9 规则与系统填充

- `combatSystem` 改为从 `gameDef.rules.combat` 读参数，实现伤害结算。
- 新增 `spawningSystem`，从 `gameDef.spawns` 读种群规则。
- 补 `inventorySystem`/`interactionSystem` 最小实现 + 物品/交互配置 schema。

### 9.10 网络层

- `GameRoom` 职责收窄为传输/输入/同步/调试。
- `EntityState` 增加可配置字段映射（按 `gameDef.netSync`），不写死 x/y/hp/shape。
- `server.ts:118` 的 `define("game", GameRoom)` 支持 `gameId` 参数选择游戏。

### 9.11 工具层

- 实现 `tools/{validate,new-game,list-archetypes,gen-map,export-map,cli}.ts`。
- 暴露 `src/framework/public-api.ts`。

### 9.12 测试

- 引入 `vitest`。
- 用例覆盖：`loadGameDefinition`、`archetypeRegistry`、`systemRegistry`、`actionRegistry`、`GameInstance.step`（headless 跑 N tick 断言）。
- 用例作为"相同配置→相同运行"的回归保护。

### 9.13 文档

- 更新 `README.md`：删除 `gameLoop.ts` 引用，更新目录结构，说明配置驱动用法。
- 本 `ARCHITECTURE.md` 作为架构权威文档，随改造同步更新。

---

## 十、架构风险提示

1. **最大风险：做了配置 schema 却不抽 GameInstance。** 如果只加配置却让 `GameRoom` 继续直接装配，配置对象会通过全局 getter 散落各处，很快回到"配置在调用点现读"的老路。**`gameDef` 必须挂到 `GameWorld` 上，`GameInstance` 抽象必须落地**。

2. **schema 演进风险。** 配置一旦被 AI/人广泛使用，schema 变更成本陡增。**schema 字段要尽量少且正交**，宁可后加，不要先写死易变的字段（如具体伤害数值应进 `rules/*.json` 而非 `game.json`）。

3. **"配置能表达一切"的诱惑。** 一定会有逻辑（复杂伤害公式、自定义交互）用 JSON 表达不优雅。**必须保留 `games/<id>/overrides/*.ts` 扩展点**作为逃生口，否则框架会被迫把图灵完备塞进 JSON。

4. **btFactory 配置化的安全边界。** AI 生成的行为树可能引用未注册的动作名。`actionRegistry` 必须在 `loadGameDefinition` 时校验所有 behavior 引用的动作都已注册，**fail fast**，不要等到运行时静默失败。

5. **Colyseus Schema 字段写死的风险。** `EntityState`（`EntityState.ts`）当前写死 x/y/hp/shape/radius/w/h。一旦实体原型需要同步新字段，就得改 Schema + 重新 codegen + 客户端同步升级。**可配置字段映射要尽早设计，避免协议锁定。**

6. **测试缺失会让配置驱动退化。** 配置驱动的核心承诺是"相同配置→相同运行"。没有 `GameInstance` 的 headless 快照测试，重构和 AI 生成都无安全网。**测试必须与改造同步引入。**

7. **`games/` 目录的版本化。** AI 会频繁改 `games/<id>/*.json`。建议尽早把 `games/` 纳入 git，并把 AI 工具的写入设计为"先生成到临时文件 → 校验通过 → 原子替换"，避免半截配置污染运行时。

8. **NetworkId 与 eid 分离的兼容期。** `NetworkId.value = eid`（`playerFactory.ts:68`）改掉后，客户端的实体映射逻辑要同步更新。过渡期可在 `world.nextNetworkId` 初值上做兼容，但最终必须完全分离。

---

## 十一、总结

当前项目 ECS/物理/碰撞/AI/地图/网络的"骨头"已搭好且质量尚可，但**整层"配置定义游戏"的装配抽象缺失**，且 `GameRoom` 把传输与游戏装配耦合在一起。

改造的核心是建立三层架构：
- **框架核心**：`src/framework/` 提供注册表驱动的 ECS/系统/实体/地图/AI/规则/装配/网络适配，游戏无关。
- **配置层**：`src/games/<id>/*.json` 用 zod 校验的 `GameDefinition` 定义具体游戏，人和 AI 产出同一份结构。
- **AI/工具层**：`src/tools/` 通过 `public-api.ts` 生成/校验配置，框架运行时零依赖此层。

关键改造动作：引入 zod schema + `GameDefinition`；`archetypeRegistry`（让 `kind` 生效）；`systemRegistry`（配置驱动启用/排序）；`actionRegistry` + `btFactory` 配置化；`generatorRegistry`；`GameWorld` 挂载注册表；`GameInstance` 抽象解耦 Colyseus；`HeadlessHost` + 测试保护；`public-api.ts` + `tools/` CLI。

这些改造完成后，框架才真正具备"配置驱动、AI 可选、可快速生成不同 2D 游戏世界"的资格。
