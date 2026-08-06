# 交接信息 — Slice 7 社交进度完成（面向接手 AI）

> 本文件为切片交接索引：接手新切片（Slice 8+ 按需开启）的 AI 先读本文件 + `AGENTS.md`，
> 再按 §9 建议起点探查。文档可能滞后于代码，遇冲突以源码为准。

## 1. 仓库与分支
- **仓库**：`git@github.com:WuRunBear/game_server_test.git`
- **当前分支**：`slice-7-social`（基于 `e0d2b50`），**工作区有 S7 全部改动未提交**（按协作流程交付停在未提交状态；含 S6 收尾的 HANDOFF 小更新）
- **历史提交**（slice-1~6，未推送，供你了解历史，不要动）：`de84e65` / `bc65473` / `e190ea5` / `c2bc223` / `2b80722` / `e67bb46` / `fbf724e` / `e48820e`（slice-1~5）+ `e0d2b50` feat(slice-6)（49 文件）
- **S7 未提交改动范围**（git status 可见）：framework 事件总线/组件/系统/协议/持久化/加载 + slice7.test.ts + game/*.json（dialogues/quests/villager/game.json）+ 文档四件（PLAN/ROADMAP/HANDOFF/README）

## 2. 工作树环境与分支创建（新 AI 必读，否则报错）
> 本仓库用 **opencode worktree** 开发：主仓库在 `~/data/code/game/game_server_test`，
> 每个 opencode 会话被分配一个独立 worktree（路径形如
> `~/.local/share/opencode/worktree/<hash>/<目录名>`），**目录名是历史遗留的
> 会话名，与当前分支无关**——本会话目录叫 `slice-1-survival-loop`，但当前分支
> 是 `slice-7-social`。**不要**试图 `cd` 到主仓库或别的 worktree 干活，
> **不要**用 `git worktree add` 新建 worktree（opencode 已替你建好）。

**开始新切片时的分支创建**（在**当前 worktree 目录内**执行，基于当前 HEAD）：
> 注意：当前工作区有未提交改动——先与用户确认（提交 S7 或另存）再切分支，勿直接 checkout。

```bash
pwd                              # 确认在 ~/.local/share/opencode/worktree/*/ 下
git status --short               # 必须干净（有输出则先提交/暂存，否则切分支会报错）
git checkout -b slice-8-xxx      # 基于当前 HEAD 创建并切换（名称按实际切片改）
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
| `AGENTS.md` | 铁律 + AoS 陷阱 + S5 陷阱（持久化/联机）+ SAVE_DIR env；S6/S7 陷阱记在 HANDOFF §7（AGENTS 不膨胀） |
| `docs/SURVIVAL-ISLAND-PLAN.md` | S1-S7 全 ✅；S7 含实施修正（范围取舍/任务双形态/事件总线/talk 交互键/AoS 组件/效果驱动/提交结算） |
| `docs/ROADMAP.md` | 17 系统覆盖表 + S7 完成声明（**验收 198**）；缺口：faction/achievement/progression 记录不修、LagComp 未做 |
| `README.md` | 目录结构（dialogues/quests 段、events/、AoS 四组件）+ 对话与任务章节 + 组件 39 / 系统 17 已同步 |

## 5. Slice 7 交付内容（代码现状）
- **帧内事件总线**：`framework/events/gameEvents.ts`——`world.runtimeEvents` + `emitEvent`/`consumeEvents`（同类型一次取出全部并清空，其他类型保留）；`GameInstance.step` 帧首清空（事件不跨帧堆积）；`combatSystem.attackTarget` 致命一击 emit `killed`（killer/victim/kind，饿死等非攻击致死无事件）
- **对话**：`Dialogue` AoS 组件挂玩家（瞬态会话 {npcId/treeId/nodeId/options}——**入 worldSerializer 瞬态名单**，恢复后自然重建）+ `DialogueSource` AoS 挂 NPC（{treeId} + initDialogueSource 钩子）；`dialogueSystem` 原子模块——`startDialogue`（talk 意图路由，距离校验 talkRange 缺省 48）/`advanceDialogue`（选项推进：先执行效果，失败不推进停留可重试；`__end__`/缺省结束）/`applyDialogueEffect`（quest_accept / quest_submit / relation_delta，submit 好感对象=对话 NPC kind）；PlayerCommand `dialogue` {option}
- **任务**：`Quest` AoS 组件挂玩家（持久 {questId/state/count}，state 0未接/1进行/2可交/3完成）；`questSystem` tick 体——collect 型读背包计数 / kill 型消费本帧 killed 事件（**先整体取出一次再分发**——consumeEvents 清空式消费，多任务共享）；`acceptQuest`/`submitQuest` 原子（collect 消耗任务物品跨槽贪婪 + 奖励 dry-run 防满包丢产出 + 好感 + DONE；kill 仅计数）；`game/quests/*.json` 配置段（collect 需 itemKind，kill 需 victimKind）
- **好感**：`Relation` AoS 组件挂玩家（持久 {npcKind/value}）+ `addRelation`/`getRelation` 原子
- **配置加载**：GameDefinitionSchema 加 `dialogues`/`quests` 段 + `resolvedDialogues`/`resolvedQuests` + GameInstance 建 `dialoguesByKind`/`questsByKind` 索引；validateIntegrity 校验（DialogueSource.treeId → 树、效果 questId → 任务、collect itemKind/rewards → item 目录、kill victimKind → 实体原型）
- **协议**：PlayerInput 加 `talk`（GameRoom isPlayerInput 校验）→ applyInputs 写 Intent "talk" → interactionSystem talk 路由最近 [NPC]（range 内）→ startDialogue；PlayerCommand 加 `dialogue` + `option`（GameRoom 白名单）
- **netSync**：AoS 适配器 4 个（Dialogue 展平 npcId/treeId/nodeId/options.索引、DialogueSource treeId、Quest questId/state/count、Relation npcKind/value）；game.json 加 4 条
- **game/**：game/dialogues/villager.json（start → tasks 节点：接/交两任务 + 离开）、game/quests/quests.json（collect_axe：交 axe×1 → spear×1+好感10 / hunt_task：击杀 wolf×2 → cooked_meat×1+好感15）、villager 挂 DialogueSource
- **测试**：`slice7.test.ts` +11 用例（事件总线、killed 事件、start/advance 全路径、效果三型、accept/collect/kill 进度、submit 结算零副作用、talk 路由、Quest/Relation 入档 + Dialogue 跳过、真实配置任务线全链路），**198 全绿**

## 6. 关键设计决策（"为什么"）
1. **范围取舍：对话+任务+好感，faction/achievement/progression 不做**：PLAN 原列 6 系统按即需即补收敛——故事闭环只需对话树承载剧情、任务驱动目标、好感回馈关系；成就/等级是离线统计与第三成长维，无 demo 需求牵引
2. **任务双形态（用户决策）**：collect 型纯配置（背包计数，零新机制）+ kill 型需要事件——落地帧内事件总线（无订阅解耦的最简队列，帧首清空防堆积）；事件消费方先整体取出再分发（清空式消费的共享语义）
3. **对话入口=新交互键（用户决策）**：PlayerInput.talk 独立意图而非复用 interact——对话是显式社交动作，与采集（interact）语义分离；客户端协议扩展面可控（一个可选布尔字段）
4. **对话/任务/好感全部 AoS 组件挂玩家**：变长结构走 S1 定型的 AoS 家族机制（初始化钩子 + 同步适配器 + worldSerializer 全量入档）；Dialogue 入瞬态名单（会话重连重开，与 Velocity/AIState 同类），Quest/Relation 持久（进度/好感随玩家存档）
5. **效果驱动任务（对话节点选项挂效果）**：accept/submit 不新开命令通道，而是对话选项效果——任务线完全由对话树配置编排（换任务线只改配置）；效果失败不推进（玩家停留可重试，无需失败分支节点）
6. **submit 好感对象=对话 NPC kind**：提交行为发生在对话中，对象即对话对象——任务定义不声明好感对象，消除配置重复与漂移
7. **击杀事件在 combatSystem 发射而非 deathSystem**：attackTarget 是唯一知道"谁打的最后一击"的点（deathSystem 处理饿死等无击杀者死亡，不产生击杀事件）
8. **quests/dialogues 走配置段（game.json glob）而非 rules/**：对话树/任务是内容不是规则——独立配置段 + 独立 schema + validateIntegrity 引用完整性（treeId/questId/itemKind/victimKind/rewards 五类引用）

## 7. 陷阱（既有基础上新增）
- **consumeEvents 是清空式消费**：同一类型事件只能消费一次——多消费方场景先整体取出再分发（questSystem 先例），不要让第二个系统再 consume 同类型（会得到空）
- **事件总线帧首清空**：GameInstance.step 开头 `world.runtimeEvents = []`——在 step 之外手动调系统（测试直接调 questSystem）时事件不会自动清，测试需自管理
- **AoS 组件挂玩家但玩家实体须有该组件名**：Quest/Relation 无初始化钩子（运行时写入）——spawn 时 archetype 声明了组件但 spawnEntity 对无钩子 AoS 跳过 addComponent——**组件名注册表有即可**（netSync tags 限定查询依赖 registry.has）；序列化按组件注册表全量遍历（`eid in arr` 存在即入档）
- **legacy AoS 跨 world 互踩（继续加强）**：Quest/Relation/Dialogue/Intent 数组测试间残留——spawnTestPlayer 统一清理（slice7 先例）；恢复用例中"模拟重启"需显式清空瞬态数组（restoreWorld 不清 Dialogue）
- **restoreWorld 按 archetype 重建**：测试存档往返必须注册带 `tags: ["Player"]` 的恢复原型，否则恢复实体无 Player tag（query [Player] 找不到）
- **真实配置测试词表红线**：S7 任务 demo 原用 wood/berry_pie 违规——game 配置调整避开词表（任务收 axe 交 spear，奖励 cooked_meat；quest id 用 collect_axe/hunt_task；victimKind wolf 只出现在 game/ 配置，测试不引用）；**新真实配置测试先自查词表词**
- **对话推进需要对话对象存活**：advanceDialogue 按 npcId 反查实体（findNpcByNetworkId）——对话中 NPC 被击杀会失败（效果不执行、对话停留）；demo 可接受，后续如需"隔空对话"再议
- **submitCommand 命令频率限流覆盖对话**：maxCommandsPerSec（20/s）对连续对话点击足够，但测试中对话推进与 craft 等共用窗口——命令密集断言注意
- 其余 S1-S6 陷阱（AoS 家族、destroyEntity、触发判定与碰撞分离互斥、systemRuntimes 选择性重建、存档异步写、schema:gen 空文件、Colyseus async onCreate）不变

## 8. 已知待办（未修，不要擅自处理）
- **待办已清零**（本切片无遗留缺陷）；记录不修：factionSystem / achievementSystem / progressionSystem（无真实需求牵引）、对话选项好感解锁条件（无消费方）、postgres/redis 真实现（等真实部署需求）、`schema:gen` 空文件（工具链问题）、LagComp（ROADMAP 缺口）
- 基线三命令：`pnpm test`（198 全绿）+ `npx tsc --noEmit`（0）+ `pnpm tools validate`（✓）+ framework 游戏词 grep 空（blackboard 技术词豁免，rg 未安装时用 grep 工具核对）

## 9. 下一步：Slice 8+（按需开启）
- **核心七切片全部完成**：S1 生存循环 → S2 战斗闭环 → S3 合成装备 → S4 世界氛围 → S5 联机完整度 → S6 建造与场景切换 → S7 社交进度（对话/任务/好感）。Demo 覆盖：能活/能打/有成长/世界活/服务端重启不丢进度/多玩家各自视野/超速被拒/建造庇护所挡狼/进洞穴来回/与岛民对话接任务交任务
- 计划：`docs/SURVIVAL-ISLAND-PLAN.md` 末尾「完整目标」——剩余可做：achievement/progression/faction（S7 记录不修项）、对话好感解锁条件、NPC 寻路（Pathfinding ROADMAP 缺口）等，按真实需求取舍；原计划注明"按需开启，不在当前 demo 执行范围内"
- 建议起点：先与用户确认是否继续开切片（非强制）→ 若开，按 §2 处理工作区后建分支 → 三命令确认基线 → 读 PLAN 对应章节 → 探查 `framework/systems/gameplay/dialogueSystem.ts`（效果驱动原子先例）、`framework/events/gameEvents.ts`（事件总线）、`framework/systems/gameplay/questSystem.ts`（tick 进度 + 命令原子双形态）
- **交付形态**：实现 + 测试 + 文档同步完成后停在未提交状态，向用户交付总结，等待验收与指令
