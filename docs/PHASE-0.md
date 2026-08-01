# Phase 0 — 框架缺陷修复（切片前止血）

> 本文件为一次性的执行清单，供单独会话按项推进。Phase 0 完成后可删除本文件，
> 或将其 5 条记录折叠进 `docs/ROADMAP.md` 的"待修复"小节。

## 背景

`survival-island` 按垂直切片推进，铁律要求"一个切片未完成不开启下一个（缺陷阻塞除外）"。
以下 5 个都是已核实、阻塞切片的框架级缺陷，必须先于 Slice 1（生存循环）修完。

**约束**（来自 `AGENTS.md` §AI 协作铁律，强制）：
- 游戏逻辑永远不写进 `framework/`——修复必须用通用机制表达，类型名/参数保持游戏无关。
- 通用的接口，最小的实现——只修手头的缺陷，不借机扩投机能力。
- 每个修复带一条测试，验收以 `pnpm test` + `tsc --noEmit` 全绿为准。

**降风险前提（已核实）**：内置 8 系统的注册全部用 `after`、无一用 `before`
（见 `framework/systems/registerBuiltinSystems.ts`），故缺陷 #4 的语义修正对现有系统零回归影响。

---

## 缺陷 1 — combatSystem 全图 AOE

**位置**：`framework/systems/gameplay/combatSystem.ts:43`
**根因**：target 循环无距离判定，攻击者每 tick 攻击全图所有目标。
**修法**：
- 给 `Attack` 组件增加 `range` 字段（单位：像素；0 表示近战默认值，行为等价旧全场——但默认值取一个合理近战数如 `Attack.range` 默认 32，或保留 0=全场为兼容）。**推荐**：`range` 默认值取一个有限近战值（如 32），并在 `game/rules/combat.json` 暴露可配置项 `attackRange`，combatSystem 优先读配置、回退组件字段、再回退默认。
- target 循环内用 `Transform` 算 `Math.hypot` 距离，超过 `range` 则 `continue`。

**验收**：射程外目标 0 伤害；新增 1 条单测：spawn 攻击者 + 远近两个目标，断言只近目标掉血。
**游戏无关性检查**：不引入 enemy/monster 等词；"range" 是通用战斗概念，OK。

---

## 缺陷 2 — spawningSystem countInZone 失效

**位置**：`framework/systems/gameplay/spawningSystem.ts:24`
**根因**：`countInZone(world, kind, zoneId)` 数的是全世界 NPC 总数——不按 `kind` 过滤，也不按 zone 多边形点包含过滤。
**修法**：
- 遍历 `query(world, [NPC])` 时，对每个 eid 取其 kind（需能查到——见下"kind 来源"）做过滤。
- 再判 `Transform.x/y` 是否落在 zone 多边形内（射线法/厘清点包含；可放一个工具函数到 `framework/utils/`）。
- **kind 来源**：当前 `spawnEntity` 没把 kind 写回实体。两个方案择一：
  - (a) 在 `spawnEntity` 时把 `ArchetypeSpec.kind` 写到一个新的 `Kind` SoA 组件（最通用，未来 Loot/Perception 也用得上）。
  - (b) 复用 `aiSystem` 已有的 `eidKind: Map<EntityId,string>` 运行时（但它是 ai 私有，跨系统读破坏封装）。
  - **推荐 (a)**：新增 `Kind` 组件并注册到 componentRegistry，`spawnEntity` 写入。这是通用机制，不引入游戏词。
- 附带修：`randomPointInZone` 用包围盒而非多边形包含，点可能落在 zone 外——一并改用点包含重抽（落外则重试，限次数后回退包围盒）。

**验收**：同 zone 同 kind 满额才停刷；跨 kind 不互相挤占。新增 1 条单测：zone 内有 kind A 满 5，刷 kind B 仍生成；且 zone 外的 kind A 不计入。
**游戏无关性检查**："Kind" 组件、点包含工具——通用，OK。

---

## 缺陷 3 — inventorySystem 吞物品

**位置**：`framework/systems/gameplay/inventorySystem.ts:28`
**根因**：背包满时 `removeEntity(world, itemEid)` 仍执行，物品被销毁但未入包。
**修法**：用 flag 跟踪本 tick 是否成功入槽，未入槽则不 `removeEntity`。

**验收**：满包后物品仍在场。新增 1 条单测：spawn 玩家 + 5 个物品（4 槽），第 5 个不入包且不被移除。
**游戏无关性检查**：纯逻辑修复，无新名词。

---

## 缺陷 4 — systemRegistry before 语义反转

**位置**：`framework/systems/systemRegistry.ts:60-66`
**根因**：`s.before: [b]` 当前实现把 `b` 推入 `s` 的依赖列表（即 s 在 b 之后跑），与"before"语义相反。
**修法**：`before` 应表达"b 依赖 s"（即 b 的入度 +1 由 s 贡献）。具体改 `topologicalSort`：
- 当前代码：`for (const b of s.before) { if (specs.some(o=>o.id===b)) deps.push(b); }` —— 删除这段（before 不应建立 s→b 的依赖边）。
- 改为在构建 `graph`/`inDegree` 后，对每个 `s.before:[b]`，给 `b` 增加一条 `s` 的依赖（即 `graph.get(b).push(s)`，`inDegree.set(b, +1)`）——这样 b 要等 s 完成才入度清零，即 s 先于 b 跑。
- 注意去重（避免 after/before 共同产生重复边），并保留对缺失 b 的容错（b 不在 specs 内则忽略，如同当前）。

**验收**：新增 1 条单测，注册 A（before:["B"]）、B，断言 `buildSystems` 结果中 A 在 B 前。再跑 `pnpm test` 全绿，确认现有 8 系统顺序未变（它们的 `after` 链 ai→physics→...→interaction 仍成立）。
**游戏无关性检查**：纯框架修复。

---

## 缺陷 5 — btFactory 不收 condition 节点

**位置**：`framework/ai/btFactory.ts:33`
**根因**：`collectActionNames` 只匹配 `type === "action"`，行为树中使用 `type === "condition"` 的节点会在运行时缺函数。
**修法**：收集时一并匹配 `type === "condition"` 的节点（取其 name 同 action 一致语义）。mistreevous 的 condition 是 agent 上的方法判定，与 action 同样需要绑定到 agent，故一并注册即可。
- 注意：action 和 condition 可能同名（罕见但要避免冲突），如有冲突在收集时记日志或抛错（推荐抛错 fail-fast，符合铁律"先修扩展点"）。

**验收**：含 condition 节点的 BT 不再运行时缺函数。新增 1 条单测：定义一棵 `root > sequence > [condition[X], action[Y]]` 的树，断言 agent 同时拥有 X 与 Y。
**游戏无关性检查**：BT 是通用 AI 机制，OK。

---

## 收尾

1. `pnpm test` —— 43 + 5 新测试全绿（旧测试不应被破坏）。
2. `npx tsc --noEmit` —— 零错误。
3. `pnpm tools validate` —— game/ 配置仍校验通过（缺陷 1 若动 `game/rules/combat.json` 加 attackRange，需保证 schema 接受该字段；若 schema 拒绝，按铁律 ③ 先修 schema 扩展点再修特性）。
4. 更新 `docs/ROADMAP.md` 的"待修复"小节，从 3 条补齐到 5 条，标注已修复。
5. 提交建议：每缺陷一个 commit（`fix(combat): 攻击加射程判定…`），或 5 条一个批次——择一即可。
6. 完成后即可开 Slice 1（生存循环：Needs 衰减 + 采集 ResourceNode + interaction 语义）。