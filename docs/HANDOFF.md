# 交接信息 — Slice 6 建造与场景切换完成（面向接手 AI）

> 本文件为切片交接索引：接手新切片（Slice 7+ 按需开启）的 AI 先读本文件 + `AGENTS.md`，
> 再按 §9 建议起点探查。文档可能滞后于代码，遇冲突以源码为准。

## 1. 仓库与分支
- **仓库**：`git@github.com:WuRunBear/game_server_test.git`
- **当前分支**：`slice-6-building`（基于 `e48820e`），**工作区有 S6 全部改动未提交**（按协作流程交付停在未提交状态）
- **历史提交**（slice-1~5，未推送，供你了解历史，不要动）：`de84e65` feat(slice-3) / `bc65473` fix(slice-3) / `e190ea5` docs(slice-3) / `c2bc223` docs(handoff) / `2b80722` feat(slice-4) / `e67bb46` fix(slice-4)+docs(handoff) / `fbf724e` feat(slice-5) / `e48820e` fix(slice-5)
- **S6 未提交改动范围**（git status 可见）：framework 组件/系统/地图/仿真/传输/持久化 + slice6.test.ts + game/*.json 全套 + 文档四件（PLAN/ROADMAP/HANDOFF/README）；另含 S5 收尾遗留的 HANDOFF/ROADMAP 两文件 S5 版本文档同步（S6 已在其上继续）

## 2. 工作树环境与分支创建（新 AI 必读，否则报错）
> 本仓库用 **opencode worktree** 开发：主仓库在 `~/data/code/game/game_server_test`，
> 每个 opencode 会话被分配一个独立 worktree（路径形如
> `~/.local/share/opencode/worktree/<hash>/<目录名>`），**目录名是历史遗留的
> 会话名，与当前分支无关**——本会话目录叫 `slice-1-survival-loop`，但当前分支
> 是 `slice-6-building`。**不要**试图 `cd` 到主仓库或别的 worktree 干活，
> **不要**用 `git worktree add` 新建 worktree（opencode 已替你建好）。

**开始新切片时的分支创建**（在**当前 worktree 目录内**执行，基于当前 HEAD）：
> 注意：当前工作区有未提交改动——先与用户确认（提交 S6 或另存）再切分支，勿直接 checkout。

```bash
pwd                              # 确认在 ~/.local/share/opencode/worktree/*/ 下
git status --short               # 必须干净（有输出则先提交/暂存，否则切分支会报错）
git checkout -b slice-7-social   # 基于当前 HEAD 创建并切换（名称按实际切片改）
git branch --show-current        # 确认已是新分支
```

**常见报错与处理**：
| 报错 | 原因 | 处理 |
|------|------|------|
| `fatal: a branch named 'X' already exists` | 分支名已存在 | `git checkout X` 切过去，或换个名字 |
| `fatal: 'X' is already checked out at '...'` | 该分支被**另一个 worktree** 占用 | 不要在多个 worktree 用同一分支；在本会话内新建分支 |
| `error: Your local changes would be overwritten...` | 工作区有未提交改动 | 先提交，或 `git stash` |
| `fatal: Not a git repository` | 不在仓库目录内 | `pwd` 检查，必须在 worktree 路径下 |
| `fatal: pathspec 'X' did not match` | checkout 参数写错 | 确认是 `checkout -b 新名`（创建）还是 `checkout 已存在名`（切换） |
| `cannot switch branches while working tree dirty` | 同上，有改动未处理 | 先处理改动再切分支 |

## 3. 协作流程（强制）
> 你的产出**只到"代码完成、三命令验收通过、工作区停在未提交状态"为止**。
> **未经用户明确下令，不得做以下任何一件事**：
> - 不得运行审查轮（自审/派 agent 审代码/产出修复提交）
> - 不得 `git commit`、`git push`、`git add`
> - 不得把审查记录写回文档
>
> 正确流程：建分支 → 写代码 → 三命令全绿 + 游戏词 grep 空 → **停在这里向用户交付总结**。
> 用户看完结果后满意会**明确下令**（如"进行审查"、"提交"），你接到指令后才执行。
> 若用户要求修改，改完继续停在未提交状态。

## 4. 文档体系（先读这些）
| 文档 | 状态 |
|------|------|
| `AGENTS.md` | 铁律 + AoS 陷阱 + S5 陷阱（持久化/联机）+ SAVE_DIR env（已同步）；S6 无新增 AGENTS 陷阱（portal 的 AoS 数据筛选与 ItemMeta 同类，S7 起注意） |
| `docs/SURVIVAL-ISLAND-PLAN.md` | S1-S6 全 ✅；S6 含实施修正（静态碰撞修复/gridSnap 开关/deconstruct 所有权/Portal AoS/switchMap 原子/房间级切图语义/mapId 持久化） |
| `docs/ROADMAP.md` | 16 系统覆盖表 + S6 完成声明（**验收 185**）；缺口：LagComp 未做、社交进度全未做 |
| `README.md` | 目录结构（switchMap/gridOccupancy/portal + game 新配置）+ 建造与场景切换章节 + 组件 35 / 系统 16 已同步 |

## 5. Slice 6 交付内容（代码现状）
- **静态碰撞修复（建造前置）**：`collisionSystem` 按 `hasComponent(Velocity)` 判静态——无 Velocity 实体（建筑/资源）注册 `isStatic` body，分离时不被推开（墙挡住玩家；修复放置物被顶走的潜伏缺陷，campfire 受益）
- **建造闭环**：`placeEntity` 扩展——`rules/place.json.gridSnap`（缺省 false 保持旧行为，配置开关）开启时占位矩形对齐地图网格（`snapToGrid`，四角落格线、中心取格组中心）→ `GridOccupancy`（SoA cellX/cellY/cellW/cellH）写入 + 占用冲突校验（同格重放被拒、相邻无缝拼接）；`Placeable` 扩展 `ownerNetworkId`（0=世界物）；`deconstructEntity` 拆除原子（仅放置者可拆、范围校验 `placeRange`、`destroyEntity`、**不返还材料**）；PlayerCommand `deconstruct` + `target`（networkId），GameRoom 白名单同步
- **场景切换**：`Portal` AoS 组件（targetMap/x/y + `initPortal` 钩子 + netSync 适配器 numbers x/y + strings targetMap）；`portalSystem` tick（玩家 AABB 相交触发，单 tick 一次；**AoS 不能进 query，按 `Portal[eid] !== undefined` 筛选**）；`framework/map/switchMap.ts`——`setWorldMap`（换图 + `world.systemRuntimes.clear()` 重建碰撞/刷怪缓存）/ `enterMap`（换图 + **清场**（保留玩家内容 = Player tag / Placeable / ItemMeta（AoS 按数据存在性判定，不可 hasComponent））+ 按新图 `spawns.npcs` 布置 + 传送玩家）/ `spawnInitialNpcs`（GameInstance 与 enterMap 共用）
- **多地图**：`loadGameDefinition` 解析 registry 全部条目 → `resolvedMapSources`（key=地图 id）；`resolvedMapSource` 保持默认图兼容
- **持久化 mapId**：`WorldRecord.mapId`（serializeWorld 写 `world.map?.id`）；GameSimulation 构造读档后 `mapId ≠ 当前` → `setWorldMap` 切回（**不清场**——存档实体是用户状态，清场只属于 portal 触发路径）
- **传输层**：`TickSnapshot.mapId` → `RoomState.mapId`（string）；GameRoom 检测 mapId 变化 → 清空 `debugMapSentSubscribers` 并强制订阅者重拉新图碰撞体
- **刷怪分图**：`SpawnRule.mapId` 可选（spawningSystem 过滤 + validateIntegrity 校验地图存在）
- **切图语义**：房间级——所有玩家共享 world.map，任一玩家触发全员换图（多人洞穴=全队副本）；per-player 分图状态不在范围
- **game/**：wall/floor/door/fence/furniture（16×16，墙/门/围栏 Collider+Placeable+GridOccupancy，地板/家具无 Collider）、portal/portal_back（双向目标）、5 个 kit 物品与配方、place.json `gridSnap: true`、maps registry 加 `cave`（simple 生成器 seed 2、32×32）、populations 分图规则（cave：rock 8/夜狼 4/portal_back）
- **测试**：`slice6.test.ts` +14 用例（gridSnap on/off、格组占用、静态碰撞、deconstruct 权限、enterMap 清场保留、portalSystem 触发/无效图/不接触/完整 tick 链、缓存选择性重建、spawn mapId 过滤、存档 mapId 往返、真实配置全链路），**187 全绿**；既有适配：slice5 Placeable 断言 + ownerNetworkId、slice3 recipes 6→11
- **审查修复（第一轮）**：portal 触发死锁（严格小于触发判定与碰撞 SAT 分离互斥——真实运行永不触发；修复=portal 配置去 Collider + `aabbOverlap` 放宽 `<=` 接触判定 + 完整 tick 链集成用例）、换图缓存改选择性重建（`systemRuntimes` 只删 collision/spawning，保留 death 重生标记与 ai 黑名单）、读档地图无效告警（P2）

## 6. 关键设计决策（"为什么"）
1. **静态判定用 Velocity 组件而非显式静态标记**：玩家/生物全部声明 Velocity（movementSystem 驱动），建筑/资源不声明——"无 Velocity = 静态"与移动系统语义天然一致，零配置增量；放置物无需额外 isStatic 字段
2. **gridSnap 是配置开关且缺省 false**：保持 S4 任意坐标放置行为与既有测试零影响；对齐是建造语义（墙/地板拼接）而非放置通用需求，真实配置开启
3. **拆除所有权按 networkId 而非 eid**：networkId 稳定对外标识（跨存档/重连保真），eid 跨存档失效；owner 0 = 世界物不可拆（地图静态放置物与玩家放置物同 kind 可区分）
4. **Portal 用 AoS 而非 SoA**：targetMap 是字符串引用（地图 id），SoA 数值数组承载不了；AoS 家族（初始化钩子 + 同步适配器）是 S1 定型机制，直接复用
5. **清场保留"玩家内容"三件套**：Player tag（玩家）/ Placeable（玩家放置物）/ ItemMeta（地面掉落）——场景生态（资源/NPC/刷怪实体）随图重置，玩家产出跨场景保留；ItemMeta 是 AoS 无组件标志，必须按数据存在性判定（hasComponent 恒 false 会误删掉落物）
6. **读档恢复走 setWorldMap 而非 enterMap**：存档实体是用户状态（含已刷生态），清场会删掉玩家进度；清场只属于 portal 触发的场景切换路径
7. **systemRuntimes 换图必须清空**：collisionSystem 的 mapBodies 与 spawningSystem 的计时器都是惰性缓存（首次 tick 构建）——不重建则旧图阻挡格残留（穿墙）与刷怪计时错乱
8. **切图=房间级（全员换图）**：单 world 单地图模型下 per-player 分图状态意味着每玩家独立地图实例 + 实体归属，复杂度远超本切片需求；"洞穴=全队副本"对 demo 足够
9. **SpawnRule.mapId 过滤而非按图分文件**：spawn 规则仍单文件（populations.json），`mapId` 字段限定作用图——配置集中可读，validateIntegrity 可整体校验

## 7. 陷阱（既有基础上新增）
- **AoS 组件不能进 bitecs query**：`query(world, [Transform, Portal])` 恒空（Portal 是 JS 数组）——portalSystem 按 `query(world, [Transform])` + `Portal[eid] !== undefined` 筛选；**凡是新 AoS 组件在系统里"查实体"都必须这样**（ItemMeta/Needs 等已有先例）
- **hasComponent 对 AoS 组件恒 false**：item 实体从不挂 ItemMeta bitecs 组件（AoS 无组件标志）——清场保留判定 `ItemMeta[eid] !== undefined`；同理 destroyEntity 清 AoS 残留靠注册表全量遍历
- **静态碰撞的 check2d 分离方向按质心**：一帧位移若超过半个碰撞体宽度，移动方质心会越过静态体中心 → check2d 把它推向另一侧（"穿墙"假象）。300px/s + 50ms = 15px 撞 16px 厚墙就会发生；测试用温和速度，真实游戏中玩家速度远低于此
- **清场后 eid 复用**：enterMap 布置新实体复用被清实体 eid——断言/追踪实体存活按 Kind/networkId 而非 eid 裸比
- **legacy AoS 数组跨 world 互踩**（既有陷阱加强）：ItemMeta/Kind 等全局数组在测试间残留，eid 复用后误判——测试里 spawn 前显式清零（slice6 enterMap 用例先例）
- **真实配置测试的配置词红线**：slice5 先例是真实配置用例用 `campfire`（不在 grep 词表）；slice6 用 `wall_kit`（同样不在词表），**wood/stone 字面量不得出现在 framework/（含测试）**——合成验证由 validateIntegrity + slice3 真实配置用例覆盖
- **触发判定与碰撞分离互斥**（S6 审查教训）：带阻挡 Collider 的触发区（portal）会把玩家分离到**恰接触**（SAT 分离到 Size 半宽和）——严格 `<` 相交判定恒 false 死锁。**触发/交互判定一律用 `<=` 接触判定**；触发区实体本身（传送门）不带 Collider
- **systemRuntimes 选择性重建**：setWorldMap 只删地图相关缓存（collision/spawning 常量 key 在 switchMap），`clear()` 全清会丢 deathSystem 重生标记（重复掉落/重置重生延迟）与 ai 黑名单——新增缓存 key 前先想清楚它是否随地图变化
- **生成器随机障碍干扰测试**：simple 生成器 5% 随机障碍格会挡住测试移动路径（碰撞链用例必须手工覆盖 blocked 全 0 地图；真实配置集成用例的放置/移动路径避开出生点右侧 villager）
- **collisionSystem 惰性缓存换图重建**：setWorldMap 后地图相关缓存必须重建，否则旧图 mapBodies 残留（碰撞调试推送 /debug/colliders 与实体碰撞都会错）
- **RoomState.mapId 是 string 字段**：schema 无字符串场景时客户端 codegen 注意；`debugMapSentSubscribers` 清空后 GameRoom 会强制推一次含地图体的完整碰撞快照（换图客户端重拉）
- 其余 S1-S5 陷阱（AoS 家族、destroyEntity 统一出口、存档异步写、schema:gen 空文件、Colyseus async onCreate、mistreevous RUNNING 记忆等）不变

## 8. 已知待办（未修，不要擅自处理）
- **待办已清零**（本切片无遗留缺陷）；记录不修：门为静态阻挡（可开关门无真实需求）、拆除不返还材料、per-player 分图状态（房间级切图语义）、postgres/redis 真实现（等真实部署需求）、`schema:gen` 空文件（工具链问题）、LagComp（ROADMAP 缺口）
- 基线三命令：`pnpm test`（187 全绿）+ `npx tsc --noEmit`（0）+ `pnpm tools validate`（✓）+ framework 游戏词 grep 空（blackboard 技术词豁免，rg 未安装时用 grep 工具核对）

## 9. 下一步：Slice 7+（按需开启）
- **核心 + 建造完成**：S1 生存循环 → S2 战斗闭环 → S3 合成装备 → S4 世界氛围 → S5 联机完整度 → S6 建造与场景切换（"玩家塑造世界"）。Demo 覆盖：能活/能打/有成长/世界活/服务端重启不丢进度/多玩家各自视野/超速被拒/网格对齐建造庇护所挡狼/拆除/进洞穴来回
- 计划：`docs/SURVIVAL-ISLAND-PLAN.md` 末尾——**Slice 7+ 社交进度**（"世界有故事"：relationshipGraph/dialogueSystem/questSystem/factionSystem/achievementSystem/progressionSystem + NPC 对话/任务线/阵营/成就配置）；原计划注明"按需开启，不在当前 demo 执行范围内"
- 建议起点：先与用户确认是否继续开切片（非强制）→ 若开，按 §2 处理工作区后建分支（如 `slice-7-social`）→ 三命令确认基线 → 读 PLAN 对应章节 → 探查 `framework/systems/gameplay/portalSystem.ts`（AoS 数据筛选系统先例）、`framework/map/switchMap.ts`（world 级能力先例）、`framework/simulation/GameSimulation.ts`（submitCommand 路由）
- **交付形态**：实现 + 测试 + 文档同步完成后停在未提交状态，向用户交付总结，等待验收与指令
