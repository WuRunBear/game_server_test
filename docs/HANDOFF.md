# 交接信息 — Slice 3 合成与装备完成，准备 Slice 4（面向接手 AI）

> 本文件为切片交接索引：接手新切片（当前为 Slice 4）的 AI 先读本文件 + `AGENTS.md`，
> 再按 §9 建议起点探查。文档可能滞后于代码，遇冲突以源码为准。

## 1. 仓库与分支
- **仓库**：`git@github.com:WuRunBear/game_server_test.git`
- **当前分支**：`slice-3-crafting-equip`（基于 `1766703`），工作区**干净**，HEAD = `e190ea5`
- **已有提交**（3 个，**未推送**，供你了解历史，不要动）：`de84e65` feat(slice-3) / `bc65473` fix(slice-3) / `e190ea5` docs(slice-3)

## 2. 工作树环境与分支创建（新 AI 必读，否则报错）
> 本仓库用 **opencode worktree** 开发：主仓库在 `~/data/code/game/game_server_test`，
> 每个 opencode 会话被分配一个独立 worktree（路径形如
> `~/.local/share/opencode/worktree/<hash>/<目录名>`），**目录名是历史遗留的
> 会话名，与当前分支无关**——本会话目录叫 `slice-1-survival-loop`，但当前分支
> 是 `slice-3-crafting-equip`。**不要**试图 `cd` 到主仓库或别的 worktree 干活，
> **不要**用 `git worktree add` 新建 worktree（opencode 已替你建好）。

**开始新切片时的分支创建**（在**当前 worktree 目录内**执行，基于当前 HEAD）：

```bash
pwd                              # 确认在 ~/.local/share/opencode/worktree/*/ 下
git status --short               # 必须干净（有输出则先提交/暂存，否则切分支会报错）
git checkout -b slice-4-world-atmosphere   # 基于当前 HEAD 创建并切换
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
| `docs/SURVIVAL-ISLAND-PLAN.md` | S1 ✅、S2 ✅、**S3 ✅（含实施修正 + 第一轮审查修复记录）**、S4-5 未开始 |
| `docs/ROADMAP.md` | 14 系统覆盖表 + S3 完成声明（**已知滞后：验收数写 126 实为 128，未修**） |
| `README.md` | 组件 31 / 系统 14 已同步 |

## 5. Slice 3 交付内容（代码现状）
- **组件 +2（SoA）**：`Equipment`（weapon/tool/armorSlot 引用 inventory 槽 idx，-1=空）、`CraftingStation`（stationType: ui32，0=通用手搓）
- **equipmentSystem**（注册系统，after interaction）：`equipSlot` 原子 + `getEquipModifiers` on-read 加成（攻防累加/采集倍率乘算，槽类型匹配校验，空槽/换物自愈）+ tick 体槽位卫生（空槽或物品不再匹配槽类型 → 归 -1）
- **craftingSystem**（原子模块，无 tick 体不注册系统）：`craftRecipe` —— 站点/缺料/满包校验（dry-run 克隆模拟）零副作用，跨槽贪婪消耗
- **schema**：`ItemKindSchema.equip`、`CraftingRuleSchema`（注册 "crafting"）、`validateIntegrity` recipe 引用校验
- **既有系统**：combatSystem 攻防加成、gatheringSystem gatherMult 倍率（≤0 拒含 directConsume）
- **传输层**：PlayerCommand + craft/equip + recipe；submitCommand 统一死亡守卫；GameRoom 白名单
- **game/**：items 10（新增 stone/axe/stone_axe/spear/berry_pie/cooked_meat）、rock/campfire 实体、crafting.json 5 配方、player Equipment、populations +2、game.json 系统 + netSync
- **测试**：`slice3.test.ts` +24 用例，128 全绿

## 6. 关键设计决策（"为什么"）
1. **Equipment 用 SoA 非 AoS**：固定三标量，原生 query/netSync，免钩子/适配器；-1 哨兵 + 读取自愈
2. **装备加成 on-read 修正**（用户拍板）：组件值不变——无 base 字段、无逐 tick 变异、测试残留面最小
3. **crafting 走 PlayerCommand 非 Intent**：意图是字符串脉冲承载不了配方 id；无 tick 体按 inventoryOps 先例做成模块
4. **stationType 0=通用手搓**约定；campfire 走 population 放置（框架暂无静态实体机制）
5. **满包拒 = dry-run 克隆**：先消耗只会空出更多空间，dry-run 通过则真实必成功
6. **死亡窗口命令全拒**：补了 S2 遗留缺口（consume/drop/transfer 原无守卫），行为变化

## 7. 陷阱（既有基础上新增）
- **SoA 未声明字段残留（潜伏）**：spawn 只写配置声明字段；新增 archetype 的 Equipment/CraftingStation 配置不完整会残留上一实体值。当前 player.json 三槽全声明规避；S5 前再议
- **真实 game 配置 load 全局 override player 原型**（S2 已有）：slice3.test.ts 两个真实配置用例触发，文件顺序 slice3→survival 已验证无冲突
- **游戏词红线**：framework/ 下 `wood/stone/axe/berry` 等只能出现在 game/ 与 src/；测试一律 m1/w1/t1 通用名
- **命令死亡守卫**：死亡窗口内 craft/equip/consume/drop/transfer 全部 false
- 其余 S1/S2 陷阱（AoS 家族、vitest 无 simulation 别名、测试串行）不变

## 8. 已知待办（未修，不要擅自处理）
- `docs/ROADMAP.md` 验收数 126 → 128（极小修正，等用户下令）
- 记录不修：spawn 字段残留（S5 前）、craftRecipe 部分产出（设计取舍）、attackTarget 缺 Transform/Team 边界（S2 既有）
- 基线三命令：`pnpm test`（128 全绿）+ `npx tsc --noEmit`（0）+ `pnpm tools validate`（✓）+ framework 游戏词 grep 空

## 9. 下一步：Slice 4（世界氛围，"世界活了"）
- 计划：`docs/SURVIVAL-ISLAND-PLAN.md` §S4 —— `TimeOfDay`（world 级）、`LightSource`、`Placeable`、可选 `Weather`；dayNightCycleSystem（phase 切换触发生成规则）；`SpawnSchema` 加 `condition`（夜刷 wolf）；BT 节点 `IsNight`/`Sleep`/`SeekLight`；wolf 夜间敌对回避火光；campfire 升级为 LightSource + CookingStation（S3 已放静态 campfire，S4 直接扩展）
- 建议起点：按 §2 建分支 → 三命令确认基线 → 读 PLAN §S4 → 探查 `spawningSystem.ts`（condition 扩展点）、`SpawnSchema.ts`、`btFactory/actionRegistry`（新 BT 节点注册）、`perceptionSystem`（火光回避感知扩展）
- **交付形态**：实现 + 测试 + 文档同步完成后停在未提交状态，向用户交付总结，等待验收与指令
