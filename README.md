# bitECS 无头游戏服务器

基于 **Node.js + TypeScript + bitECS + Colyseus** 的无头（Headless）游戏服务器，提供多人联网、ECS 架构、物理碰撞、AI 行为树与地图系统。

## 快速开始

```bash
pnpm install
pnpm dev     # tsx 热重载
pnpm build   # tsc 编译
pnpm start   # 运行 dist/index.js
```

默认监听端口 **3001**，可通过 `.env` 中 `PORT` 覆盖。

## 服务端点

| 路径 | 说明 |
|------|------|
| `GET /health` | 健康检查 |
| `GET /maps/runtime` | 运行时地图数据（JSON） |
| `GET /debug/colliders` | 碰撞体调试快照 |
| `ws://localhost:PORT` | Colyseus WebSocket（客户端接入） |

## 目录结构

```
src/
  index.ts                  # 入口
  main.ts                   # 初始化 Colyseus 服务器
  world.ts                  # GameWorld 类型 + createGameWorld
  gameLoop.ts               # 固定 tick 循环（当前不使用，由 GameRoom 驱动）
  metrics.ts                # tick 性能指标

  components/               # ECS 组件（bitecs SoA）
    transform.ts            # Transform（x/y/rot/scale）
    physics.ts              # Velocity / Acceleration / Collider
    combat.ts               # Health / Attack / Defense / Team
    ai.ts                   # AIState / Target / BlackboardRef
    inventory.ts            # Inventory（AoS 示例）
    network.ts              # NetworkId / LastSynced
    timer.ts                # Cooldown / Duration
    tags.ts                 # Player / Enemy / NPC / Item（Tag）
    size.ts                 # Size（w/h）

  systems/                  # 系统层（按序执行）
    index.ts                # 注册与执行顺序
    core/                   # 物理 / 移动 / 碰撞
      physicsSystem.ts      # 加速度 -> 速度
      movementSystem.ts     # 速度 -> 位置
      collisionSystem.ts    # 实体-实体、实体-地图碰撞（check2d）
    gameplay/               # 玩法系统
      aiSystem.ts           # 行为树推进
      combatSystem.ts       # 死亡清理
      inventorySystem.ts    # 占位
      interactionSystem.ts  # 占位

  network/colyseus/         # 网络层（Colyseus）
    server.ts               # HTTP + WebSocket 服务器配置
    rooms/GameRoom.ts       # 房间逻辑：onCreate / onJoin / onLeave / step
    state/                  # Schema 定义
      RoomState.ts          # tick / players / entities
      PlayerState.ts        # sessionId / entityId
      EntityState.ts        # id / x / y / hp / shape / radius / w / h

  map/                      # 地图系统
    types.ts                # 类型定义
    tiled.ts                # Tiled JSON 解析
    buildRuntime.ts         # 运行时地图构建
    generated/simple.ts     # 程序化地图生成
    exportGenerated.ts      # 导出地图 JSON + PNG

  ai/                       # 行为树（Mistreevous）
    blackboard.ts           # 实体黑板
    btFactory.ts            # 行为树工厂
    btRunner.ts             # 行为树执行器
    nodes/actions/          # 自定义行为节点
      idle.ts               # 空闲
      wander.ts             # 随机游走

  factories/                # 实体工厂
    playerFactory.ts        # 玩家实体
    npcFactory.ts           # NPC 实体

  database/                 # 持久化（占位）
    repository.ts           # 接口定义
    postgres.ts             # stub
    redis.ts                # stub

  config/                   # 配置
    server.ts               # 端口 / CORS
    game.ts                 # tickRate（20）
    map.ts                  # 地图注册表读取

  utils/
    logger.ts               # Winston 日志
    timer.ts                # clampMs
```

## 架构

### 游戏循环

由 `GameRoom.setSimulationInterval` 驱动，每 tick 依次执行：
1. 接收客户端输入（`moveX` / `moveY`）
2. 执行系统：AI → 物理 → 移动 → 碰撞 → 战斗 → 背包 → 交互
3. 同步状态到所有客户端（ECS → Colyseus Schema）

### 碰撞系统

使用 `check2d` 库进行 SAT 碰撞检测。支持：
- 圆形（Circle）与矩形（Box）碰撞体
- 实体-实体碰撞及分离
- 实体-地图阻挡格碰撞，碰撞后速度置零

### AI 行为树

NPC 使用 Mistreevous 行为树驱动。当前支持：
- Idle：原地等待
- Wander：随机方向移动，到达地图边界自动折返

### 地图系统

支持两种地图源：
- **Tiled 编辑器**：解析 JSON 格式，读取 collision / objects / zones 层
- **程序化生成**：围墙 + 随机障碍物 + NPC 出生点

当前配置使用程序化生成（64×64 地图）。

### 网络同步

Colyseus Schema 每 tick 同步实体位置、血量、碰撞体形状到客户端。服务端权威，客户端发送输入不直接操作实体。

## 扩展指南

### 新增组件

```ts
export const Mana = { current: [] as number[], max: [] as number[] }
export const Boss = {}
```

在 `src/components/` 新建，`index.ts` 导出，工厂函数中使用 `addComponent`。

### 新增系统

在 `src/systems/<domain>/` 新建，在 `src/systems/index.ts` 的 `createSystems()` 数组中注册（顺序即执行顺序）。系统约定为 `(world: GameWorld) => GameWorld` 纯函数，不做阻塞 I/O。

### 新增实体（工厂函数）

参考 `playerFactory.ts`，在 `src/factories/` 新建，`index.ts` 导出，集中完成 `addEntity` + `addComponent` + 初始值写入。

### 数据库持久化

实现 `src/database/repository.ts` 接口并在 `GameRoom` 中调用 `savePlayer` / `loadPlayer`。

## 技术栈

| 类别 | 技术 | 版本 |
|------|------|------|
| 运行时 | Node.js | >=22（ESM） |
| 语言 | TypeScript | ^5.8 |
| ECS | bitecs | ^0.4.0 |
| 网络 | @colyseus/core + @colyseus/ws-transport | ^0.17 |
| Schema 同步 | @colyseus/schema | ^4.0.25 |
| 碰撞检测 | check2d | ^9.36.4 |
| 行为树 | mistreevous | ^4.3.1 |
| 日志 | winston | ^3.19 |

## 状态

这是一个头服骨架，ECS 架构与网络基础已完备，核心玩法系统（背包、交互、战斗伤害、农场、任务等）尚待填充。
