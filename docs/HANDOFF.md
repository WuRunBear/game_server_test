# 交接信息 — Slice 4 世界氛围完成，准备 Slice 5（面向接手 AI）

> 本文件为切片交接索引：接手新切片（当前为 Slice 5）的 AI 先读本文件 + `AGENTS.md`，
> 再按 §9 建议起点探查。文档可能滞后于代码，遇冲突以源码为准。

## 1. 仓库与分支
- **仓库**：`git@github.com:WuRunBear/game_server_test.git`
- **当前分支**：`slice-4-world-atmosphere`（基于 `c2bc223`），HEAD = `2b80722`，**工作区有 10 文件审查修复未提交改动**（见 §5 末）
- **已有提交**（4 个，**未推送**，供你了解历史，不要动）：`de84e65` feat(slice-3) / `bc65473` fix(slice-3) / `e190ea5` docs(slice-3) / `c2bc223` docs(handoff) / `2b80722` feat(slice-4)

## 2. 工作树环境与分支创建（新 AI 必读，否则报错）
> 本仓库用 **opencode worktree** 开发：主仓库在 `~/data/code/game/game_server_test`，
> 每个 opencode 会话被分配一个独立 worktree（路径形如
> `~/.local/share/opencode/worktree/<hash>/<目录名>`），**目录名是历史遗留的
> 会话名，与当前分支无关**——本会话目录叫 `slice-1-survival-loop`，但当前分支
> 是 `slice-4-world-atmosphere`。**不要**试图 `cd` 到主仓库或别的 worktree 干活，
> **不要**用 `git worktree add` 新建 worktree（opencode 已替你建好）。

**开始新切片时的分支创建**（在**当前 worktree 目录内**执行，基于当前 HEAD）：

```bash
pwd                              # 确认在 ~/.local/share/opencode/worktree/*/ 下
git status --short               # 必须干净（有输出则先提交/暂存，否则切分支会报错）
git checkout -b slice-5-online-completeness   # 基于当前 HEAD 创建并切换
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

## 3. 协作流程（强制，本切片起生效）
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
| `AGENTS.md` | 铁律 + AoS 陷阱（未变） |
| `docs/SURVIVAL-ISLAND-PLAN.md` | S1 ✅、S2 ✅、S3 ✅、**S4 ✅（含实施修正 + 第一轮审查修复记录）**、S5 未开始 |
| `docs/ROADMAP.md` | 15 系统覆盖表 + S4 完成声明（验收 155）；**已知滞后：S3 验收数写 126 实为 128，未修** |
| `README.md` | 组件 33 / 系统 15 已同步 |

## 5. Slice 4 交付内容（代码现状）
- **组件 +2（SoA）**：`LightSource`（radius/fuelRemainingMs，≤0 熄灭）、`Placeable`（footprintW/footprintH/canCollide）；`TimeOfDay` **world 级**（`world.time.timeOfDay = {hour, phase}`，PHASE_DAY=0 / PHASE_NIGHT=1，非 bitecs 组件）
- **dayNightCycleSystem**（注册系统，before spawning）：hour 连续推进（0-24 取模）+ 跨午夜相位（nightStart 19 > nightEnd 5）；`DayNightRuleSchema`（cycleLengthSec/nightStartHour/nightEndHour）；无规则 no-op
- **spawnConditions 注册表** + `SpawnSchema.condition`（isNight 内建）：spawningSystem 计时/上限检查后判定；**condition 不满足不刷且不重置 timer**；validateIntegrity 校验 condition 已注册
- **placeableSystem**（原子模块，无 tick 体）：`placeEntity` —— 距离（`rules/place.json` placeRange 默认 64）/实体重叠/地图阻挡校验零副作用 → 消耗 1 → spawn；`ItemKindSchema.place`（archetype 引用）
- **BT 节点**：conditions `IsNight`/`IsInLight` + action `Sleep`（**SUCCEEDED 语义**）；btFactory/validateIntegrity 支持 mistreevous `while/until` guard 条件收集（单对象形态）
- **火光回避（感知侧）**：perceptionSystem 通用约定——目标处于任一有效 LightSource 半径内不可感知（"光=安全区"），狼树用 IsInLight 入睡 + while IsNight guard 保昼眠
- **传输层**：PlayerCommand `place`（slot+x+y）+ TickSnapshot.timeOfDay → RoomState hour/phase（world 级同步，不经 netSync）
- **game/**：wolf（Health 80/感知 180/team 2/夜间敌对）、wolf-night 行为树、campfire 升级（LightSource radius 80 + CraftingStation 1 + Placeable 24×24）、campfire_kit（3 木 + 2 石配方）、daynight.json（600s）/place.json（64）、populations 夜刷 wolf（condition isNight，max 2）、game.json（15 系统 + netSync LightSource/Placeable 字段）
- **测试**：`slice4.test.ts` +27 用例（dayNight/spawnCondition/BT 节点/猎手集成含天亮停手/placeEntity 校验/命令路由/真实配置），155 全绿
- **审查修复（第一轮，工作区未提交，10 文件）**：Sleep RUNNING→SUCCEEDED（RUNNING 记忆睡死/追击残留根治）、wolf-night 追击分支加 while IsNight guard（天亮停手）、validateIntegrity 行为树校验修复（原空转：补 child 递归 + call 收集）、guard 数组死代码清理（单对象）、IsTargetNotInVision 节点删除（无消费方）

## 6. 关键设计决策（"为什么"）
1. **TimeOfDay 挂 world.time 非组件**：world 级状态非实体属性；二进制相位（无晨昏渐变消费方，不造）
2. **火光回避在感知侧而非 BT 条件**："光=安全区"一处生效全局受用；且 mistreevous RUNNING 记忆下纯 BT 条件方案不可行——selector 只重 tick 记住的 RUNNING 子节点，FAILED 分支在 RUNNING 期间不被重评估（入睡后无法醒）
3. **Sleep 返回 SUCCEEDED 而非 RUNNING**：RUNNING 制造状态记忆 → 条件变化无法改判；SUCCEEDED 让树根每 tick 重置、全树重评估——"见敌即醒/天亮停手/光源失效改判"自然达成，且避免 guard 中止不清速度的残留（guard 失败路径不执行节点本体）
4. **guard 是 mistreevous 唯一每 tick 重求值的机制**（while/until，单对象 `{call}` 形态），用于中断 RUNNING 中的行为（如追击中天亮）
5. **placeEntity 走 PlayerCommand 非 Intent**（crafting 先例）：离散事件需坐标参数；`place` 在 GameRoom 白名单
6. **condition 刷怪不重置 timer**：条件满足后的下一个计时窗口自动生效，避免每 tick 失败计数
7. **campfire 为静态 + 玩家放置双来源**：population 规则放置（S3 既有）+ campfire_kit 玩家放置（S4）；无"放置上限"区分，玩家放置会计入 kind 计数

## 7. 陷阱（既有基础上新增）
- **mistreevous RUNNING 记忆（S4 核心坑）**：FAILED 分支在 RUNNING 期间不被重评估；分支切换只能靠分支 FAILED/SUCCEEDED 或 guard。写行为树时：让"待机/睡眠"类动作返回 SUCCEEDED 保持树可重评估；需要中断 RUNNING 中的追击/攻击用 `while` guard（挂在 sequence 上即可，mistreevous 校验接受复合节点挂 guard）
- **guard 中止不执行节点本体**：被 guard 中断的动作不会执行自身清理逻辑——树要有无条件兜底分支执行清零（wolf-night 分支 3 无条件 Sleep）
- **Sleep 语义**：SUCCEEDED（每 tick 清零速度 + 完成一帧），不是 RUNNING 常驻；旧测试若断言 RUNNING 需同步改
- **validateIntegrity 行为树校验**（S4 已修，写新树时注意）：collectActionNames 认 `children` + `child`、`name` + `call`、guard 单对象条件名——新增节点形态时需同步维护
- **legacy 数组跨 world 互踩**（S2 既有，S4 再现）：测试 spawn 后显式清零 Cooldown 残留（spawnTestHunter 先例：`Cooldown.remainingMs[eid] = 0`）
- **游戏词红线**：framework/ 与测试一律通用名（w1/hunter/k1/plc）；真实配置用例可用 campfire（不在 grep 词表），**wolf/wood/stone 字符串不得出现在 framework/**（含测试）
- 其余 S1/S2/S3 陷阱（AoS 家族、vitest 无 simulation 别名、测试串行、真实配置 load 全局 override player 原型）不变

## 8. 已知待办（未修，不要擅自处理）
- `docs/ROADMAP.md` S3 验收数 126 → 128（极小修正，等用户下令）
- 记录不修：Weather / SeekLight（无消费方）、zone 分区（simple 生成器硬编码单 zone）、LightSource 燃料消耗（fuel=1e9 常亮，留待真实需求）、Placeable.canCollide 无消费方
- 基线三命令：`pnpm test`（155 全绿）+ `npx tsc --noEmit`（0）+ `pnpm tools validate`（✓）+ framework 游戏词 grep 空（blackboard 技术词豁免，rg 未安装时用 grep 工具核对）

## 9. 下一步：Slice 5（联机完整度，"能存档开服"）
- 计划：`docs/SURVIVAL-ISLAND-PLAN.md` §S5 —— `persistenceSystem`（定时存快照替换 stub；玩家背包/状态/世界建筑）、`interestManagementSystem`（仅同步玩家视野内实体）、`antiCheatSystem`（输入校验：速度上限、动作频率上限）
- 扩展点：`repository.ts` / `postgres.ts` / `redis.ts` 补真实现（当前方法体基本为空，**不要假设存档/读档已可用**）；`game/rules/server.json`（存档间隔/视野半径/速率上限）
- 建议起点：按 §2 建分支（先处理当前工作区未提交的审查修复）→ 三命令确认基线 → 读 PLAN §S5 → 探查 `repository.ts`/`postgres.ts`/`redis.ts`（stub 现状）、`GameRoom.applySnapshot`（RoomState 广播路径，interest management 切入点）、`GameSimulation.buildSnapshot`（netSync 全量同步现状）、`SimulationPort`（接口是否需扩持久化能力）
- **交付形态**：实现 + 测试 + 文档同步完成后停在未提交状态，向用户交付总结，等待验收与指令
