# 配置驱动的 2D 游戏服务端框架

基于 **Node.js + TypeScript + bitecs + Colyseus** 的无头游戏服务端。核心命题：**配置定义游戏，框架运行游戏，AI 可选生成配置**。

游戏内容全部由 `game/` 下的纯 JSON 声明（实体、行为、地图、规则、物品、对话、任务），框架按配置驱动仿真：地图由生成积木管道产出、实体由演化引擎按规则补差、系统按拓扑序 tick，网络层与仿真层经 `SimulationPort` 解耦（服务端权威，客户端只发输入）。

## 快速开始

```bash
pnpm install
pnpm dev      # tsx 热重载
pnpm build    # tsc 编译
pnpm start    # 运行 dist/src/index.js
pnpm test     # 运行测试（vitest）
```

默认监听端口 **3000**（见 `framework/config/server.ts`），可通过 `.env` 中 `PORT` 覆盖。

## 工具

```bash
pnpm tools validate                    # 校验 game/ 配置（含每图管道链与实体规则数）
pnpm tools new-game --id my-game       # 生成 game/ + src/ 骨架
pnpm tools list-registries             # 列出已注册的原型/动作/系统/生成积木
pnpm tools gen-map <mapKey> --out out/            # 生成地图（key 见 game/maps/registry.json）
pnpm tools export-map <mapKey> --out out/ [--palette <file>]  # 导出 JSON+PNG（色表为工具参数）
```

## 架构总览

```
tools/        ← AI/工具层 — 通过 framework 公共 API 操作框架
src/          ← 游戏入口 — bootstrapFramework → 启动服务
framework/    ← 框架核心 — 游戏无关，所有通用逻辑
game/         ← 游戏配置 — 纯 JSON：实体、行为、地图、规则、生态、模板
```

依赖方向严格自上而下：`tools → framework`、`src → framework`。`framework` 不反向依赖任何游戏代码或工具代码——游戏逻辑永远不进 framework（见 `AGENTS.md` §AI 协作铁律）。

框架核心按五层地图系统（geometry / generate / evolution / runtime / 网络接口）+ ECS 仿真 + 持久化 + 传输解耦组织；运行机制、目录详图与各子系统说明见 **`docs/architecture.md`**。

## 文档导航

| 文档 | 内容 |
|------|------|
| `AGENTS.md` | AI 协作索引与铁律（接手项目先读） |
| `docs/architecture.md` | 目录结构详图、运行机制、子系统说明、扩展指南 |
| `docs/ROADMAP.md` | 系统覆盖现状、缺口、分阶段路线图 |
| `docs/ecosystem-map-design.md` | 地图生态化设计契约与三切片实施记录 |

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
