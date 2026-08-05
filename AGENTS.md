# AGENTS.md — 项目高层次概括

> 本文件为 AI 代理（opencode/Claude/Cursor 等）提供项目上下文，供会话间复用。
> 它**只是索引与规则**：人类上手见 `README.md`，系统覆盖与进度见
> `docs/ROADMAP.md`，架构机制以源码为准（文档可能滞后于代码）。

## 项目定位

**配置驱动的 2D 游戏服务端框架**，基于 Node.js + TypeScript + bitecs + Colyseus。

核心命题：**配置定义游戏，框架运行游戏，AI 可选地生成配置。** 框架游戏无关，所有游戏内容由 `game/` 下的 JSON 声明，人类或 AI 产出同一份结构化配置。

- 仓库：`git@github.com:WuRunBear/game_server_test.git`
- Node >= 22, TypeScript ^5.8, pnpm 工作区

## AI 协作铁律（全局强制约束）

> 本节为所有 AI 代理在本仓库制定或执行**任何修改计划**时的强制约束，
> 优先级高于本文件其他描述性内容。技术性禁止清单见下文「扩展硬边界」。

### 铁律：游戏逻辑永远不写进 framework/
实现新特性时按顺序决策：
1. 先尝试纯 `game/*.json` 配置表达
2. 缺能力则在 `framework/` 加**通用机制**（如"Needs 衰减系统"而非"饥饿系统"，参数全走配置，类型名保持游戏无关）
3. 若现有扩展点表达不了，**先修扩展点**，再写特性

判据：`framework/` 下任何代码不得出现游戏专属语义（hunger / 荒岛 / wood / villager 等游戏名词）。游戏名词只能出现在 `game/` 配置与 `src/register.ts` 的注册参数中。

### 设计原则：通用的接口，最小的实现
- 即需即补 ≠ 过度设计：只需状态机时不造 GOAP；只需 4 槽背包时不造格子拖拽
- 每个新框架能力必须有**真实游戏需求牵引**，不写投机性通用层
- 框架每次只长"刚好够用且不留游戏味"的部分

### 策略：即需即补（按垂直切片推进）
- 切片顺序：生存循环 → 战斗 → 合成 → 世界 → 联机
- 每切片结束三同步：可玩 demo 前进 + 框架增长通用系统 + 测试/文档同步
- 一个切片未完成不开启下一个（缺陷阻塞除外）
- 切片详计划见 `docs/ROADMAP.md`

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

**依赖方向严格自上而下**：`tools → framework`、`src → framework`。`framework` 不反向依赖任何游戏代码或工具代码。`game/` 目录是数据（非 TS），由 `loadGameDefinition` 按路径加载。文件级目录树与逐行注释见 `README.md` §目录结构。

## 文档与代码索引

去哪里找什么——**文档可能滞后于代码，遇冲突以源码为准**（可用 explore 代理快速核实）。

| 你要找 | 去这里 |
|--------|--------|
| 架构机制（GameWorld / 各 Registry / 扩展点 / 配置模型） | 读 `framework/` 源码：`world.ts`、`bootstrap.ts`、各 `*Registry.ts` 与 `registerBuiltin*.ts` |
| 目录结构详图、tsconfig、路径别名 | `README.md` §目录结构 + `tsconfig.json` 的 `paths` |
| 系统覆盖现状、缺口、待修缺陷、分阶段路线图 | `docs/ROADMAP.md` |
| 人类快速上手、工具命令、技术栈一览 | `README.md` |
| 当前游戏内容（实体 / 行为 / 地图 / 规则 / 生成点） | `game/*.json` |
| 当前真实注册的组件/系统/动作/原型/生成器 | `pnpm tools list-registries` 或读 `framework/*/registerBuiltin*.ts` |
| 当前自定义扩展（是否已有游戏专属代码） | `src/register.ts` |

## 核心运行机制（极简）

- **启动**：`src/index.ts → main.ts → bootstrapFramework() → startColyseusServer(gameJsonPath) → loadGameDefinition → createGameInstance → GameRoom.setSimulationInterval`。
- **每 tick**：`GameRoom` 收输入写 `Velocity` → `gameInstance.step(dtMs)` 按拓扑序跑系统 → 把 ECS 状态派生为 Colyseus `RoomState` → 调试快照节流推送。
- **Registry 模式**：组件/系统/动作/原型/生成器/规则统一用「名 → factory」注册表；`bootstrapFramework()` 建表（幂等单例），`createGameInstance()` 挂到 `world`，系统经 `world` 访问。各表细节见 `framework/` 下的 `*Registry.ts` 与 `registerBuiltin*.ts`。
- **网络**：服务端权威，`RoomState` 是每 tick 从 ECS 派生的视图；同步字段由 `gameDef.netSync.fields` 配置（无硬编码）；稳定 `NetworkId` ≠ eid。见 `framework/simulation/` 与 `framework/net/`。
- **仿真/传输解耦**：`SimulationPort` 接口隔离传输层与 ECS；`GameRoom`（联机）与 `HeadlessHost`（测试/单机）共用同一 `sim.tick(dtMs)`，`GameRoom` 不导入任何 bitecs/ECS 符号。见 `framework/simulation/SimulationPort.ts`。

## 扩展点速查

注册扩展都在 `src/register.ts`；完整代码示例见 `README.md` §扩展指南。

| 扩展点 | 注册函数 | 配置中引用 |
|--------|---------|-----------|
| System | `registerSystem()` | `game.json` 的 `systems[].id` |
| Component | `registerComponent()` | `entities/*.json` 的 `components` 块 |
| Action | `registerAction()` | `behaviors/*.json` 的 `action.name` |
| RuleModule | `registerRuleModule()` | `rules/*.json` 的 `xxxRef` 字段 |
| Generator | `registerGenerator()` | `maps/registry.json` 的 `generatorId` |
| Archetype | 自动加载 | `entities/*.json` |

### 扩展硬边界

> 战略级约束见上方「AI 协作铁律」；本节为技术性禁止清单的细化。

- 禁止：直接修改 framework 源码、修改 GameWorld 核心结构、绕过 network layer 发消息、在系统里做异步 I/O
- 替换内置系统：注册同名替代 + 在 `game.json` 中启用新系统、停用旧系统

## AI 须知陷阱

易踩、且看代码未必能发现：

- **AoS 组件家族**：`Inventory` / `Kind` / `Needs` / `ResourceNode` / `ItemMeta` / `Intent` 都是普通 JS 数组（`[] as T[]`，按 eid 索引），与其余 SoA（bitecs 数值数组）不一致。它们**不是 bitecs 组件**——不能 `addComponent`、不能进 `query`。spawn 经组件注册表的 **AoS 初始化钩子**（`registerAosInitializer`）按 archetype 配置写入；netSync 经 **AoS 同步适配器**（`registerAosSyncAdapter`，按 `tags` 限定查询）展平为 numbers/strings。扩展此类组件时注意访问方式与查询方式。
- **S5 持久化陷阱**：`repository.ts` 接口已是**世界快照**（`Repository.saveWorld/loadWorld(WorldRecord)`，旧 PlayerRecord/MapInstanceRecord 已删除，无消费方）；默认后端是 `createFileRepository`（`data/saves/`，`SAVE_DIR` 覆盖），**postgres/redis 仍为 stub**（无驱动依赖，不要假设可用）。存档序列化**跳过瞬态组件**（Velocity/Target/AIState/BlackboardRef/Cooldown/Duration/Intent/LastSynced/Kind），恢复后由系统与输入自然重建；恢复出的玩家实体由 `addPlayer` 复用绑定（networkId 保留），`removePlayer` 仍删除实体（断线后进度以最近存档为准）。`createGameSimulation(gameDef, options?)` 的 `options` 含 `repository/saveId/initialRecord`。
- **S5 联机陷阱**：`game/rules/server.json`（`ServerRuleSchema`）同时驱动三件事——`saveId/saveIntervalMs`（存档）、`viewRadius`（兴趣裁剪，无此配置则全量广播 `RoomState.entities`，**旧协议兼容**）、`maxMoveSpeed/maxCommandsPerSec`（输入校验）。persistence 与输入校验**不是 ECS tick 系统**（异步 I/O 与入口校验不入 tick，实为 GameSimulation 层能力）。兴趣裁剪后实体数据在 `PlayerState.visibleEntities`（per-client），客户端项目注意协议适配点。
- **`vitest.config.ts` 缺 `simulation` 路径别名**：测试中直接 `import from "simulation"` 会失败，须经 `framework` barrel 间接引入。
- **持久化后端**：默认为 `createFileRepository`（JSON 文件，`data/saves/`，`SAVE_DIR` 覆盖）；`postgres.ts` / `redis.ts` 仍为 stub（无驱动依赖），不要假设外部数据库可用。
- **当前缺陷与覆盖进度见 `docs/ROADMAP.md`**，不在本文件枚举（随修复实时变化）。

## 常用命令

```bash
pnpm install              # 安装依赖
pnpm dev                  # tsx 热重载开发（端口见环境变量）
pnpm build                # tsc 编译 + tsc-alias 路径重写
pnpm start                # 运行 dist/src/index.js
pnpm test                 # vitest run
pnpm tools validate       # 校验 game/ 配置
pnpm tools list-registries  # 列出当前注册项
pnpm tools gen-map simple --out out/            # 生成地图
pnpm tools export-map [mapId] --out <dir>       # 导出 MapRuntime
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | 3000 | 服务监听端口（见 `framework/config/server.ts`） |
| `CORS_ORIGINS` | — | 跨域白名单（逗号分隔，空则允许 *） |
| `GAME_CONFIG_PATH` | `game/game.json` | 游戏配置路径 |
| `SAVE_DIR` | `data/saves` | 存档目录（文件仓储后端，见 `framework/persistence/fileRepository.ts`） |