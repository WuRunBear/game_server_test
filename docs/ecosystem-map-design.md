# 生态化地图系统设计（荒岛求生 × 饥荒式地图）

> 状态：设计已确认，待分切片实施。
> 前置阅读：`map-system-design.md`（现有五层地图系统）、`ROADMAP.md`（切片总路线）。
> 本文是 2026-09-16 地图生态化 brainstorm 的最终结论，所有决策已经用户确认。

## 1. 背景与目标

现有地图系统机制完备（生成/演化/持久化/网络/工具链闭环，329 项测试通过），但内容稀疏：
island 仅 4 气候区且规则全部挤在 `plain`，9 个内置积木只有 4 个被配置使用，template 演化模式
从未使用。本次以"饥荒"式地图为参照，把地图做大、做丰富、做合理，过程中补齐已确认的框架缺口。

**四要素**（用户全选）：群落生态分区、固定地点 setpiece、子地图扩展、动态机制（巢穴/袭击）。

## 2. 已锁定的决策

| 决策点 | 结论 |
|---|---|
| 实施方式 | 总设计一次成型，实施分 3 个垂直切片 |
| 生成哲学 | 噪声生成 + 模板盖印双轨，都作为管道积木自由组合（A+C 混合） |
| 地图尺寸 | 全部由 `game/maps/registry.json` 配置决定，框架零默认值（island 目标 192×192） |
| 内容深度 | 变体优先：新物种 = 现有组件/行为的参数变体；仅缺能力时新增通用组件 |
| 村庄生成 | 双轨：规则生成（template 规则实体组）/ 整村模板盖印 / 混合模式 |

## 3. 分层职责（不变式）

```
生成层（buildMapGeometry 管道）  → 只产地理：tiles / walkable / regions
演化层（evolve 引擎）           → 只产实体：density / exact / template 三模式
框架改动原则                    → 真实需求牵引；每片结束测试全绿 + 可玩验证
```

## 4. 三切片路线图

| 切片 | 内容 | 框架改动 |
|---|---|---|
| ① 生态分区与地基 | island 192×192、5 气候区 + wilderness + 模板区、区域×物种表；新积木 `stamp-template` | `canPlace` 多格占用、占用/计数索引化、重复规则身份校验、新档随机种子入口 |
| ② setpiece 与子地图 | template 规则实战化（房屋组/营地）；新增 swamp/ruins 子图；portal 网络 | 按需小增量 |
| ③ 动态机制 | 巢穴（蜘蛛巢/蜂巢式母体）、周期袭击、时段条件扩展 | `Nest` 通用组件 + gameplay 巢穴系统；`spawnConditions` 扩展 |

依赖：① 的 region 体系是 ②③ 的载体；② 的实体丰富度是 ③ 的前提。

## 5. 切片①：生态分区与地基

### 5.1 island 生态分区方案

**地形管道**：

```jsonc
// game/maps/registry.json（示意）
[
  { "generator": "noise-terrain", "params": {
      "width": 192, "height": 192, "tileWidth": 16, "tileHeight": 16,
      "bandLevel": 0.35, "falloff": 0.6,          // falloff 造 ocean 环带
      "groundPalette": { "1": 0.35, "2": 0.45, "3": 0.55, "4": 0.68, "5": 0.8, "6": 1 },
      "nonWalkableSemantics": [1] } },
  { "generator": "climate-regions", "params": {
      "names": ["beach", "grassland", "forest", "swamp", "rocky"],
      "style": "noise", "minArea": 800 } },
  { "generator": "stamp-template", "params": { "tiledPath": "templates/pig-village.json", "region": "grassland" } },
  { "generator": "region-stats", "params": {} }
]
```

**语义 id 表**（数字→含义的命名映射在 game 配置侧，框架只见数字）：

| id | 语义 | 通行 |
|----|------|------|
| 1 | deep_ocean | 否 |
| 2 | sand | 是 |
| 3 | grass | 是 |
| 4 | forest_floor | 是 |
| 5 | swamp_mud | 是 |
| 6 | rock | 是 |

**区域×物种表**（entity-rules.json 从 16 条扩到约 40 条；新物种全部为参数变体）：

| 区域 | 新增变体（复用基础） | 沿用实体 |
|---|---|---|
| beach | shell_node（berry_bush）、crab（rabbit） | — |
| grassland | carrot_patch（berry_bush） | berry_bush、rabbit、villager、boar |
| forest | mushroom（berry_bush）、spider（wolf，巢区高密度） | tree、wolf |
| swamp | reed（berry_bush）、frog（boar） | water_pool |
| rocky | gold_rock（rock） | rock、wolf |
| wilderness | — | 树/石零星密度 |
| pig-village（模板区） | — | villager、campfire |

### 5.2 新积木 `stamp-template`（模板盖印）

**模板契约**：模板 = 内联 Tiled JSON，复用 `tiled-source` 解析约定，三种约定图层（全部可选，至少其一）：

| Tiled 图层 | 类型 | 含义 | 盖印效果 |
|---|---|---|---|
| `ground` | tilelayer | tile id = 地面语义 id（0~255） | 覆盖目标矩形 `tiles`（**新约定**，tiled-source 的 tiles 恒为 0，此为关键增量） |
| `collision` | tilelayer | 非 0 = 不可通行 | 覆盖目标矩形 `walkable` |
| `zones` | objectgroup | `type="zone"` + 属性 `zoneId`/`name` | 模板区域栅格化进 `regions`，成为演化规则的 region 引用 |

框架不解释模板里的其他对象/属性（objects 层第一版不迁移，与 tiled-source 现状一致）。

**参数契约**：

| 参数 | 必填 | 约束 | 违反时 |
|---|---|---|---|
| `tiled` / `tiledPath` | 二选一必填 | 内联 Tiled JSON / 加载期内联的路径 | 缺失/给 path 字符串 → 抛错 |
| `at` 或 `region` | 二选一必填 | `at`=模板左上角 tile 坐标；`region`=落点区域（确定性选点） | 都缺/都给 → 抛错 |
| `anchor` | 可选 | 模板内锚点 tile 坐标，缺省 `{0,0}`；region 选点时锚点对齐选点格 | 非法 → 抛错 |

- `tiledPath` 是**加载期**约定：`loadGameDefinition` 读文件内联为 `params.tiled`，积木仍零文件 I/O。
- 校验风格与 `noiseTerrain.parseParams` 一致：入口 fail-fast 收窄，错误消息点名地图 key 与具体参数。

**四层防线**（"生成规则怎么限制模板"）：

1. 积木入口自校验：模板矩形不越界、ground 值 ∈ [0,255]、at/region 互斥、region 模式要求前序积木已建 regions；
2. 管道顺序约束：必须在 sizing 积木（noise-terrain 等）之后，前置不满足即抛错；
3. 出口校验兜底：`validateMapGeometry` 的连通性告警覆盖"盖出不可走孤岛"，零覆盖告警覆盖"模板区域没盖上"；
4. 开机 U5 闭环：规则引用的 region 若依赖模板而模板没盖成，boot 引用校验直接抛错。

**确定性**：region 选点的候选序列 = `deriveStream(seed, stepIndex)` 纯函数；越界只过滤候选；
候选耗尽 = 配置错误 → 抛错（生成期失败宁可起不来服务器，不静默跳过）。

**覆盖权**：后写覆盖先写（管道顺序即优先级）；模板 zones 追加进 regions 末尾并重写覆盖格的
`regionOfTile`；同名 zone 合并指向同键（文档写明，第一版不做改名映射）。

### 5.3 村庄/建筑生成（双轨）

| 模式 | 地形（生成层） | 建筑（演化层） | 适用 |
|---|---|---|---|
| 纯规则生成 | 不画模板，用生态区域 | 房屋=实体组，template 规则确定性撒"房屋+围栏+水井" | 散落小村落、废弃营地 |
| 整村模板 | Tiled 画整村盖印 | 村民/NPC 用 density 规则补进模板区域 | 地标性城镇 |
| 混合（推荐） | 模板只画场址：地基+道路+`village` 区 | 房屋实体由 template 规则在区内长出来 | 大型村庄 |

"房屋模板" = entity-rules.json 里可复用的 template 条目组（`{kind,dx,dy}`），引擎零改动
（`spawnTemplate` 的整组校验/原子创建/确定性选点已就绪）。

### 5.4 框架修复清单（4 项）

1. **`canPlace(kind, x, y)` 多格占用感知**（修真实缺陷）：现状占用集按实体中心 tile 记录、
   `spawnTemplate` 只查锚点单格——2×2 建筑（`Placeable.footprintW/H`）会互相重叠。改为：
   占用集按 footprint 整矩形登记，三模式落点检查统一走 `canPlace(kind, x, y)`（读原型 footprint
   展开逐格检查可走+未占用）。
2. **占用/计数索引化**（性能）：`evolveDeps` 的 `countByKind`/占用集全表扫描 → tile→eid 空间网格；
   `regionOf` 线性遍历 regions 键 → 区域名数组直查。
3. **重复规则身份校验**：boot 时 `ruleIdentity`（map|region|kind|mode）去重检测，重复即抛错
   （schema.ts 注释里声明"归后续 todo"的账）。
4. **新档随机种子入口**：`WorldRecord` 增加 `mapSeeds: Record<string, number>`；registry 的 seed
   是固定值时可省略，新档未声明 seed 时随机生成并随首存快照固化，读档复用快照 seed
   （旧存档直接废弃、无兼容负担——项目既定约定）。

### 5.5 交付物与验证

- registry.json island 重配置（192×192、5 气候区 + wilderness + 模板区、stamp 步骤）；entity-rules 按区展开
- 新模板文件 2~3 个（`game/maps/templates/pig-village.json` 等）
- 框架修复 4 项 + 各自单测
- 验证：`pnpm tools validate` → `pnpm tools export-map island --out out/` PNG 前后对比 →
  boot 冒烟 → `pnpm test` 全绿 → 性能抽查（boot 生成耗时、20tps 稳定性）

## 6. 切片②：setpiece 与子地图

- **setpiece 实战**：template 规则撒营地/石阵/房屋组；同一份条目组跨规则复用。
- **子地图 ×2**：
  - `swamp`（96×96）：noise 多水 band + 专属生态（reed/frog/触手变体），portal 互联 island；
  - `ruins`（64×64）：**slot-rooms 积木首次实战**（房间网格 + walls 结构区），高敌对密度 +
    稀有资源，形成难度梯度。
- **portal 网络**：island↔swamp↔ruins；exact 规则 + 现有 U5 配对互指校验（Chebyshev ≤ 2 邻近落点）兜底。
- **村庄混合模式落地**：pig-village 模板盖场址，房屋实体规则生成。

## 7. 切片③：动态机制

- **`Nest` 通用组件**（AoS：`{spawnKind, capacity, intervalTicks, current}`）+ gameplay 层巢穴系统：
  周期在巢周围 `canPlace` 产出 `spawnKind` 实体至容量；巢（实体）被摧毁即停产——无独立存活状态。
- **周期袭击**：走现有 `registerRuleModule` 扩展点（rules/*.json 的 xxxRef），按玩家位置周期刷
  敌对波——框架零新概念。
- **时段条件扩展**：`spawnConditions` 注册表新增 `isDay`/`isWinter` 等（isNight 同款机制）。
- 蜂场/蜘蛛巢与 Nest 组件配合；切片②的模板直接复用。

## 8. 验证策略（每切片）

`pnpm tools validate` → `pnpm tools export-map <key> --out out/` PNG 前后对比 →
boot 冒烟 → `pnpm test` 全绿 → 性能抽查（192×192 boot 生成耗时、20tps 稳定性）。

## 9. 拒绝的替代方案

- **生态声明层**（framework 引入 biome→物种表中间概念）：与 entity-rules 现有模型重叠，违反
  "真实需求牵引"；若切片③规则配置爆炸再议。
- **全图区块拼贴**（饥荒原生做法）：重写生成层成本最大；stamp-template 已满足设计感需求。
- **生态系统仿真 / GOAP**：无真实需求，YAGNI。

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 192×192 离线补差单次 evolve 跨度成本 | 早退不变式已有界；索引化（修复项 2）先于扩内容落地 |
| entity-rules 条目膨胀（~40 条） | 平铺数组可接受，不引入 $ref 机制（YAGNI） |
| Tiled 模板制作工作量 | 第一版仅 2~3 个模板，模板即内联 JSON 可程序生成后再手修 |
| 语义 id 表漂移（配置与模板不一致） | 模板 ground 值域校验 + validate 出口校验 + export-map PNG 人工对比 |
