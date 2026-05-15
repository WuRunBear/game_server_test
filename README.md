# bitECS 无头游戏服务器骨架

这是一个基于 **Node.js + TypeScript + bitECS(0.4.x) + ws** 的无头（Headless）游戏服务器项目骨架，用于承载 ECS World、固定 tick 主循环，以及最小网络同步（快照广播）。

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式（热重载）
pnpm dev

# 构建
pnpm build

# 运行（先 build）
pnpm start
```

## 服务与端口

- HTTP
  - `GET /health`：健康检查
  - `/`：简单文本响应
- WebSocket
  - 默认地址：`ws://localhost:3000/ws`
- 环境变量
  - `PORT`：覆盖监听端口

## 目录结构（核心）

```
src/
  index.ts                 # 入口（调用 main）
  main.ts                  # 初始化：world / systems / network / loop
  world.ts                 # GameWorld 类型 + createGameWorld
  gameLoop.ts              # 固定 tick 主循环（setInterval）
  metrics.ts               # 简单 tick 性能指标
  factories/               # 实体创建工厂（按实体类型拆分）
    index.ts               # 统一导出
    playerFactory.ts       # 玩家实体工厂（createPlayer）

  components/              # 组件层（数据）
    index.ts               # 统一导出
    transform.ts           # Transform（x/y/rot/scale）
    physics.ts             # Velocity/Acceleration/Collider
    combat.ts              # Health/Attack/Defense/Team
    ai.ts                  # AIState/BlackboardRef/Target
    inventory.ts           # Inventory（AoS 示例）
    network.ts             # NetworkId/LastSynced
    timer.ts               # Cooldown/Duration
    tags.ts                # Player/Enemy/NPC/Item（Tag）

  systems/                 # 系统层（逻辑，按顺序执行）
    index.ts               # createSystems（系统注册与执行顺序）
    core/                  # 核心：物理/移动/碰撞
    gameplay/              # 玩法：战斗/交互/背包（占位）
    network/               # 网络：快照生成/广播

  network/                 # 网络层
    server.ts              # ws 服务器（收输入、广播快照）
    protocol.ts            # 消息类型定义（JSON）
    serializers.ts         # 序列化/反序列化 + 最小校验

  ai/                      # 行为树（Mistreevous）
    blackboard.ts
    btRunner.ts
    btFactory.ts
    nodes/actions/idle.ts

  utils/
    logger.ts              # 简单日志器

  config/
    index.ts               # 配置统一导出
    game.ts                # tickRate
    server.ts              # port/wsPath
```

## 架构说明（怎么运行起来）

### 1) World：ECS 数据 + 运行期上下文

`GameWorld` 不只是 bitECS world，还包含服务器运行需要的上下文：

- `time`：tick、dt、fixedDt
- `metrics`：性能指标
- `logger`：日志器
- `net`：网络运行时（可选）

实现见：[world.ts](src/world.ts)。

### 2) GameLoop：固定 tick 主循环

主循环通过 `setInterval` 以固定 tickRate 调用系统列表，并记录单帧耗时；当单帧耗时过高会输出告警日志。实现见：[gameLoop.ts](src/gameLoop.ts)。

### 3) Systems：纯函数系统 + 明确顺序

系统是 `(world) => world` 的纯函数，约定：

- 系统内部使用 `query(world, [CompA, CompB])` 找实体
- 只读写组件数据与 world 上下文，不做阻塞 I/O

系统注册与执行顺序集中在：[systems/index.ts](src/systems/index.ts)。

### 4) Network：输入/快照的最小闭环

当前网络实现是“示例级”的最小结构：

- `network/server.ts`：维护客户端集合、接收输入（目前只做存储，不驱动实体）
- `systems/network/snapshotSystem.ts`：每 tick 从 ECS 收集快照
- `systems/network/broadcastSystem.ts`：广播快照给所有客户端

协议类型见：[network/protocol.ts](src/network/protocol.ts)。

## 如何在这个架构上继续开发

### A. 新增一个组件

组件建议优先用 SoA（对象里放数组），Tag 用空对象：

```ts
export const Mana = { current: [] as number[], max: [] as number[] }
export const Boss = {}
```

步骤：

1. 在 `src/components/` 新建文件
2. 在 `src/components/index.ts` 统一导出
3. 在 `src/factories/` 的对应实体工厂里创建实体时 `addComponent(world, eid, Mana)`

### B. 新增一个系统（并控制顺序）

步骤：

1. 在 `src/systems/<domain>/` 新建系统文件
2. 在 `src/systems/index.ts` 导入并插入 `createSystems()` 返回数组（顺序就是执行顺序）

约定：系统内部不要 `await`，不要做网络请求/数据库操作。

### C. 新增一种实体（工厂函数）

在 `src/factories/` 下按实体类型新增 `xxxFactory.ts`（例如 `npcFactory.ts` / `enemyFactory.ts`），并在 [factories/index.ts](src/factories/index.ts) 统一导出；每个工厂函数集中完成：

- `addEntity`
- `addComponent`
- 组件初始值写入

### D. 把客户端输入真正作用到实体（下一步常见改造）

当前 `ws` 输入只是存储在 `world.net.latestInputByClientId`。

下一步建议加一个 `inputSystem`：

- 从 `latestInputByClientId` 读取输入
- 映射到某个实体（比如 `NetworkId` 或 “clientId -> entityId” 表）
- 写入组件（例如 Velocity / Intent）

### E. 行为树 / AI（建议的接入方式）

当前 `src/ai/` 基于 [Mistreevous](https://www.npmjs.com/package/mistreevous) 提供行为树的最小接入。建议做法：

- 行为树系统每 tick 同步推进（轻量）
- 大模型推理放到异步任务里，产出高层意图写入 blackboard/组件
- 执行系统消费意图并做“可执行性校验”，失败就回退到行为树 fallback

最小示例（为某个实体推进一帧行为树）：

```ts
import { createDefaultNpcTree } from "ai/btFactory";
import { createBlackboard } from "ai/blackboard";
import { stepBehaviourTree } from "ai/btRunner";

const bt = createDefaultNpcTree();
const bb = createBlackboard(eid);

stepBehaviourTree(bt, { world, self: eid, bb });
```

## 最小客户端示例（Node.js）

```ts
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:3000/ws");

ws.on("open", () => {
  ws.send(JSON.stringify({ t: "input", seq: 1, moveX: 1, moveY: 0 }));
});

ws.on("message", (data) => {
  console.log("server:", data.toString("utf-8"));
});
```
