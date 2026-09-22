# 计划方案：world 单位系统（tile-units）+ 世界比例修复

> 状态：待实施。本方案自包含：背景、现状盘点（含 file:line）、机制规范、决策与否决理由、
> 分文件改动清单、数值迁移表、验证方案、风险边界。执行者无需额外上下文即可开工。
> 完成后本文件补记「实施记录」小节并归档。

---

## 1. 背景与问题

### 1.1 现状观感问题

当前世界 192×192 格、每格 16px，玩家实体恰好 16×16px（正好 1 格），移速 200px/s：

- 玩家每秒跑 **12.5 格**，横穿全图仅需 **~15 秒** → 世界"感觉很小"。
- 玩家占满一整格 → 相对世界粒度过大。

### 1.2 参照系：饥荒（Don't Starve / DST）实测数据

数据来源：游戏脚本镜像（penguin0616/dst_gamescripts、ds_gamescripts）与 wiki，已核实。

| 量 | 值 |
|---|---|
| 1 格（turf tile） | 4 世界单位（`TILE_SCALE = 4`） |
| 角色碰撞体 | 半径 0.5 单位 → 占 **1 格宽度的 1/4、面积的 1/16** |
| 默认世界 | DST 425×425 格；单机 350×350 格 |
| 跑速 | 6 单位/s = **1.5 格/s** |
| 横穿默认图（直线） | **~283 秒 ≈ 4.7 分钟**（约 0.6 个游戏日） |

结论：差距来自两个因子的叠加——本仓库玩家速度在格空间里快 ~8 倍（12.5 vs 1.5 格/s），
且角色相对一格大 4 倍（1 格 vs 1/4 格）。

### 1.3 目标

1. 引入通用「单位系统」：配置允许以**格**表达量纲，加载期一次换算为 px，
   运行时系统零改动、继续只见 px。
2. 用该机制把比例调至饥荒参照系：玩家 0.5 格、跑速 2 格/s（横穿 ~96 秒）。

### 1.4 非目标（明确不做）

- 不重构现存 ~12 处内联 tile↔px 换算（与"比例单点"目标无关，另行处理）。
- 不改 tile 像素尺寸（保持 16px，理由见 §5.3）。
- 不改 AI 行为树节点的 px 默认值（`chase 60 / flee 80 / wander` fallback 语义保留，
  实际值全部走 behaviors args，本次全量显式化）。
- 不修 `inAttackRange.ts` 无视 rules/combat.json 的既有分叉（见 §8.1）。
- 不支持多图不同 tile 尺寸混排（v1 全局统一，见 §5.4）。

---

## 2. 现状盘点（scale 相关值的定义与消费点）

> 以下均已经代码核实（2026-09）。执行时如遇行号漂移，以符号名为准。

### 2.1 tile 尺寸——per-map 必填，无全局默认

| 位置 | 事实 |
|---|---|
| `game/maps/registry.json:13-14, 83-84, 131-132, 205-206` | 4 张 pipeline 图各自重复 `tileWidth:16, tileHeight:16` |
| `game/maps/tiled-demo.json:4` | Tiled 图自带 `tilewidth:16` |
| `framework/map/generate/blocks/noiseTerrain.ts:190-191, 329` | tileWidth **必填**（`requirePositiveNumber`，缺失抛错） |
| `framework/map/generate/blocks/slotRooms.ts:214-215, 394` | 同上 |
| `framework/map/generate/blocks/tiledSource.ts:164, 323` | 读 Tiled JSON `tilewidth`；缺失时回退 **1px**（既有不一致，本次不动） |
| `framework/map/generate/types.ts:62-75` | `GeometryDraft` 初始 0，由首个 sizing 块写入 |
| `framework/map/geometry/types.ts:14-23` → `pipeline.ts:60` | draft 冻结为 `MapGeometry.grid` |
| 所有消费方 | 运行时读 `geometry.grid.tileWidth/tileHeight` |

### 2.2 速度——玩家走配置，AI 默认值硬编码

| 位置 | 事实 |
|---|---|
| `game/rules/server.json:5` | `maxMoveSpeed: 200`（px/s） |
| `framework/config/schema/RuleSchema.ts:100-106` | `ServerRuleSchema`，`.passthrough()` |
| `framework/simulation/GameSimulation.ts:191-195` | 读 server 规则建 `inputGuard` |
| `framework/simulation/inputValidation.ts:52-53` | `Math.hypot(moveX, moveY) <= maxMoveSpeed` **拒绝**（非钳制） |
| `framework/simulation/GameSimulation.ts:605` | 合法输入原样写 `Velocity.vx/vy = moveX/moveY` |
| `framework/systems/core/movementSystem.ts:16-20` | `position += velocity * dtSec`（Velocity 即 px/s） |
| `framework/ai/nodes/actions/chase.ts:13` | `DEFAULT_SPEED = 60` px/s（可被 behaviors `args.speed` 覆盖） |
| `framework/ai/nodes/actions/flee.ts:13` | `DEFAULT_SPEED = 80` px/s |
| `framework/ai/nodes/actions/wander.ts:63-64` | `tileWidth * 2`，fallback `?? 16` |
| `game/behaviors/*.json` | 实际值全走 `args.speed`（wolf-night:21 → 70；boar 60；rabbit 80；wander 40/48） |
| NPC 实体 JSON | **不含速度字段**，速度只在 BT args |

### 2.3 实体尺寸——per-archetype 配置 + 两个 px fallback

| 位置 | 事实 |
|---|---|
| `game/entities/player.json:5-10` | `Size 16×16`、`Collider halfW/H 8`、`Attack.range 40`（px） |
| `game/entities/campfire.json` | `Size 24`、`Collider 12`、`LightSource.radius 80`、`Placeable.footprint 24` |
| `framework/components/physics.ts:74-78` | Collider SoA 定义 |
| `framework/systems/core/collisionSystem.ts:244-279, 189-203, 329-335` | 消费 Collider；地图 tile → 静态矩形 body |
| `framework/systems/gameplay/portalSystem.ts:19, 25-28` | fallback `DEFAULT_HALF_SIZE = 8`（px） |
| `framework/components/placeable.ts:26, 36-40, 42-50` | `FALLBACK_FOOTPRINT = 16`（px）；**footprint 刻意独立于 Size**，唯一来源 `footprintOf()` |
| `framework/entities/spawn.ts:59-83` | SoA 逐字段写入（"字段不存在则跳过，容忍配置多写"）；**:108** `EntityMap` 在组件写入**之后** |
| `framework/entities/spawn.ts`（整体） | **所有出生路径的唯一漏斗**（开机演化 / 每 tick 补差 / 离线补差 / addPlayer 均经 `spawnEntity`） |
| `game.json:42, 50`（netSync） | 同步 `Size.w/h`、`Collider.shape/radius`、`LightSource`（**halfW/H 不上网**） |

### 2.4 距离/范围——几乎全 px，spawn 半径是 tile 单位例外

| 值 | 定义处 | 消费处 | 单位 |
|---|---|---|---|
| 攻击距离 | player.json `Attack.range 40`；`game/rules/combat.json:5` `attackRange 32`；`combatSystem.ts:13` 默认 32 | `combatSystem.ts:90-100`（组件 > 规则 > 默认） | px |
| 视野/敌意 | 各实体 JSON（wolf 180、spider/boar/tentacle 160、rabbit/frog 120、crab 100） | `perceptionSystem.ts:43-60` | px |
| 光照半径 | campfire `LightSource.radius 80` | `framework/utils/light.ts:17-26` | px |
| 兴趣半径 | `server.json:4` `viewRadius 300` | `GameSimulation.ts:193` → `interest.ts:27-35`（px 距离平方） | px |
| 出生半径 | `spawnPlacement.ts:21` `DEFAULT_SPAWN_RADIUS_TILES = 4`；raid 规则 `radiusTiles` 覆盖 | `nestSystem.ts:41-44`、`raidSystem.ts:73-76` | **tile** |
| 交互距离 | `game.json:25` systems[].config `{range: 24}`；`interactionSystem.ts:12` 默认 24 | `interactionSystem.ts:48` | px |
| 放置/合成/拆解/对话 | 规则文件或默认（place 64、station 64、deconstruct 64、talk 48） | `placeableSystem.ts:71` 等 | px |

### 2.5 tile↔px 换算——约定存在，公共 helper 不存在

无 `tileToPx/pxToTile` 公共函数；内联算术 ~12 处，全部对照 `geometry.grid.tileWidth`：
`evolveDeps.ts:8-11, 41-46, 77-82, 134-135`、`map/runtime/spawn.ts:51-58, 89-91`、
`spawnPlacement.ts:71, 97-98`、`raidSystem.ts:101-103`、`nestSystem.ts:77-87`、
`projectileSystem.ts:66-67`、`respawnSystem.ts:52-53`、`utils/placement.ts:76-84, 128-134`、
`collisionSystem.ts:189-203`、`steer.ts:22-30`。约定（引擎以 tile 语义、Transform 以 px、
floor/center 换算）只记录在 `evolveDeps.ts:8-11` 注释。

### 2.6 配置管道——中心读取面已存在

- `world.gameDef`（`framework/world.ts:54`）携带 `resolvedRules: Record<basename, unknown>`
  （`GameDefinitionSchema.ts:126`；构建于 `bootstrap/loadGameDefinition.ts:666`）。
- rules 文件加载：`loadGameDefinition.ts:101-113`——basename 为 key，注册过 schema 则 zod
  解析，否则**原样透传**；内置 schema 均 `.passthrough()`（`ruleSchemas.ts:16-18`）。
- `systems[].config` → `factory(world, config)`（`systemRegistry.ts:159-185`）。
- 客户端 schema 手动副本：`src/network/colyseus/client-schema/schema.ts`（仓库无 codegen）。

---

## 3. 机制规范（实现规格书）

### 3.1 world 段：全局 tile 像寸

`game.json` 顶层新增：

```json
{ "world": { "tile": { "width": 16, "height": 16 } } }
```

- `GameDefinitionSchema.ts` 增 zod 定义：两值为正数；**v1 强制 width === height**
  （refine，错误信息说明非方形 tile 暂不支持）；缺省 16×16（兼容旧配置）。
- 语义：全局唯一 tile 像寸，是 `*Tiles` 换算的唯一基准。

### 3.2 命名约定：`xxxTiles` = 以格为量纲

通用规则（无业务语义，框架只认后缀）：

- 深度遍历目标配置树（对象 + 数组递归）。
- 键名**精确以 `Tiles` 结尾**（大小写敏感）：裸键 = 去掉 `Tiles` 后缀，
  换算值 = 原值 × `world.tile.width`，写回裸键，**删除 `Tiles` 键**。
- 距离量：格 → px（`wTiles: 0.5` → `w: 8`）。
- 速度量：格/秒 → px/秒（`maxMoveSpeedTiles: 2` → `maxMoveSpeed: 32`）。
  时间单位由字段自身语义继承，后缀只声明空间量纲，不设 `PerSec` 变体。
- 值必须为有限数 ≥ 0，否则抛配置错误（含路径）。
- **冲突检测**：同一对象内 `x` 与 `xTiles` 并存 → 抛错（含路径），转换前检测（与顺序无关）。
- px 裸键写法保持合法（两套并存、渐进迁移），**px 是运行时唯一形态**。

### 3.3 归一化的覆盖范围与时机

实现位置：新增 `framework/config/tileUnits.ts` 导出
`normalizeTileUnits(root: unknown, tilePx: number): void`（原地转换）。

接线（`framework/bootstrap/loadGameDefinition.ts`）：在 game.json / rules / entities /
behaviors 全部解析且 schema 校验通过**之后**、注册表构建之前，对以下四类结构各调一次：

1. 每个 archetype 的 `components` 块；
2. 每个 `resolvedRules[basename]`；
3. 每个 behaviors 文件的树（覆盖 BT `args`）；
4. game.json 的 `systems[].config`。

效果：碰撞/战斗/感知/光照/兴趣/交互/放置/合成/对话/演化占用等全部系统**零改动**
（如 `rules/combat.json` 写 `attackRangeTiles: 2`，combatSystem 读到的已是 px 值）。

### 3.4 地图 sizing 注入

`resolveMapConfigs`：生成块缺 `tileWidth/tileHeight` 时注入 `world.tile`
（generators 的必填校验保持不变——注入发生在配置解析层）。
Tiled 图豁免（仍读 Tiled JSON 自带 tilewidth）。
地图块**显式声明**且与 `world.tile` 不一致 → `pnpm tools validate` 输出**警告**（不阻断），
提示实体 px 尺寸按全局基准换算、可能与该图几何比例失调。

### 3.5 测试要求（`framework/__tests__/tile-units.test.ts`）

1. 距离换算：`wTiles: 0.5` → `w: 8`（tilePx=16），`Tiles` 键被删除；
2. 速度换算：`maxMoveSpeedTiles: 2` → `maxMoveSpeed: 32`；
3. 冲突抛错：`{ w: 16, wTiles: 0.5 }` → 抛错含路径；嵌套对象与数组内同样生效；
4. 非法值（负数/非有限数）抛错；
5. px 裸键透传不变；无 `Tiles` 键的结构原样通过（深拷贝语义不破坏引用共享需注意）；
6. 端到端：`wTiles: 0.5` 的 archetype 经 `spawnEntity` 后 `Size.w[eid] === 8`。

---

## 4. 改动清单

### Lane A：framework 机制（唯一写入范围 `framework/`）

| # | 文件 | 改动 |
|---|---|---|
| A1 | `framework/config/schema/GameDefinitionSchema.ts` | 增 `world.tile` zod（§3.1） |
| A2 | `framework/config/tileUnits.ts`（新增） | `normalizeTileUnits`（§3.2） |
| A3 | `framework/bootstrap/loadGameDefinition.ts` | 四类结构接线 pass（§3.3）；`resolveMapConfigs` sizing 注入 + validate 警告（§3.4） |
| A4 | `framework/__tests__/tile-units.test.ts`（新增） | §3.5 全部用例 |

不改动：全部 systems、组件定义、BT 节点、碰撞、演化、netSync、`src/register.ts`、
客户端 schema（字段形状不变，仅值变化）。

### Lane B：内容迁移第一批（唯一写入范围 `game/`）

原则：首批只迁 4 个文件验证机制与观感；机制落地后其余文件迁移是纯机械批量（见 §4.3）。

#### 4.1 B1 `game/game.json`

```json
"world": { "tile": { "width": 16, "height": 16 } }
```

#### 4.2 B2 `game/rules/server.json`

| 原值（px） | 新值（格） | 等效 px |
|---|---|---|
| `maxMoveSpeed: 200` | `maxMoveSpeedTiles: 2` | 32 px/s |
| `viewRadius: 300` | `viewRadiusTiles: 19` | 304 px（观感等效，可再调） |

#### 4.3 B3 `game/entities/player.json`

| 字段 | 原值 | 新值 | 等效 px |
|---|---|---|---|
| `Size.w/h` | 16 | `wTiles/hTiles: 0.5` | 8 |
| `Collider.halfW/halfH` | 8 | `halfWTiles/halfHTiles: 0.25` | 4 |
| `Attack.range` | 40 | `rangeTiles: 2.5` | 40（不变，仅改表达） |

其余字段（Needs/Inventory/Equipment）不动。

#### 4.4 B4 NPC 速度全量重标定（`game/behaviors/*.json` + `game/entities/campfire.json`）

基准：玩家 2 格/s。等比系数 = 2 / 12.5 = **0.16**（保持全部相对序，
谁追得上谁的关系与现状完全一致）。执行步骤：

1. `grep -n "speed" game/behaviors/*.json` 枚举全部 `args.speed`（含 chase/flee/wander）；
2. 每个值换算：`speedTiles = round(oldPx / 16 * 0.16, 2)`，字段改名 `args.speedTiles`；
3. 已知参考值：wolf 70 → 0.7；boar 60 → 0.6；rabbit 80 → 0.8；wander 40/48 → 0.4/0.48；
   chase/flee 未显式传 speed 的节点补显式 `speedTiles`（默认 60/80 → 0.6/0.8），
   使框架 px 默认值不再被实际触发；
4. `campfire.json`：`LightSource.radius 80` → `radiusTiles: 5`（80px 等效，仅改表达）。

> 平衡校验点：狼(0.7) 追不上玩家(2.0)——与现状(4.4 vs 12.5)相对关系一致，非回归。

#### 4.5 第二批（观感确认后另开任务，本方案只定范围）

- 其余 ~28 个 entities：Size/Collider、Perception（visionRadius/hostilityRange →
  `visionRadiusTiles`）、Attack.range → `rangeTiles`、Placeable.footprint →
  `footprintWTiles/H`、LightSource；
- interaction/crafting/place/deconstruct/dialogue 距离：规则文件内 `*Tiles`
  （框架 px 默认值 24/64/64/64/48 保留为 fallback）；
- `game/maps/registry.json`：4 处 `tileWidth/tileHeight: 16` 删除（走 §3.4 注入）；
- Placeable fallback：视第二批观感决定是否将 `FALLBACK_FOOTPRINT` 语义改为格
  （当前 16px 恰等于 tile，无漂移，不动）。

---

## 5. 设计决策与否决理由

### 5.1 换算时机：加载期归一化（否决：spawn 链逐实体换算）

spawn 期换算需在组件写入时解析"所在图 tile 尺寸"，但 `spawn.ts` 中 mapId 在组件写入
**之后**才落（:59-83 vs :108），需改顺序；且跨图实体（switchMap）尺寸不随图变，
"×所在图"换算无法给出跨图一致的实体尺寸——复杂度引入了、问题没解决。
加载期换算一遍覆盖全部出生/恢复路径（`spawnEntity` 是唯一漏斗，实体验证），系统零改动。

### 5.2 单次归一化（否决：每系统解析链 + `resolveTileScaled` 优先级）

按系统逐个加 `*Tiles` 字段需改 6+ 个系统与 schema，每处都要优先级逻辑与测试，
且会踩既有分叉（`inAttackRange.ts:11-14` 只读组件与默认值、无视 rules/combat.json）。
单次 pass 让优先级问题消失：系统读到配置时已是 px。

### 5.3 tile 保持 16px（否决：换 32px）

换 tile 牵连：`export-map` PNG cellSize、tiled-demo（16px Tiled JSON）与全局混排、
测试 helper 的 16 默认值（`__tests__/helpers/mapGeometry.ts:28-29`）、存档几何快照。
而"修比例"目标不需要动 tilePx：格是抽象单位，`*Tiles` + 全局 tilePx 已达成比例单点。

### 5.4 v1 全局统一 tilePx（否决：per-map 实体换算）

多 tile 尺寸混排无真实需求牵引；per-map 换算在 §5.1 已证不成立。显式不一致仅告警（§3.4）。

---

## 6. 验证方案

1. **单测**：`pnpm vitest run framework/__tests__/tile-units.test.ts`；
2. **全量**：`pnpm test` 全绿（既有用例直写 px，走兼容路径应不受影响）；
3. **配置校验**：`pnpm tools validate`（走同一加载链；冲突/非法值在此暴露；验证 registry 警告）；
4. **boot 冒烟**：dev 起服或 HeadlessHost，确认演化/出生/碰撞不报错；
5. **观感核对清单**（数值预期）：
   - 玩家 0.5 格（8px）；
   - 直线横穿全图 ≈ **96 秒**（192 格 ÷ 2 格/s；原 15 秒）；
   - 狼 0.7 格/s、兔 0.8 格/s，追逐相对关系与现状一致；
   - 兴趣半径 19 格（同屏 ~38 格宽），与改前视距等效。

---

## 7. 执行结构

| Lane | 范围 | 依赖 | 交付 |
|---|---|---|---|
| A：framework 机制 | 仅 `framework/`（A1-A4） | 无 | 机制 + 单测全绿 |
| B：内容迁移第一批 | 仅 `game/`（B1-B4） | 无（约定已在本文件定死） | 4 文件迁移完成 |
| 收口验证 | 全仓只读 | A + B 均完成 | §6 全部通过 |

A、B 无写冲突，可并行。收口验证由编排方执行；观感确认后再开第二批（§4.5）。

---

## 8. 风险与已知边界

- **8.1 既有分叉（不在本次修复）**：`inAttackRange.ts` 无视 `rules/combat.json`。
  组件值改用格表达后 BT 判定自动受益（组件优先级最高），行为不回归。
- **8.2 既有不一致（不在本次修复）**：`tiledSource.ts:164` Tiled JSON 缺 `tilewidth`
  回退 1px。
- **8.3 存档**：旧档组件值为旧 px 基准（玩家 16px 等），按仓库既定政策**旧存档直接废弃**，
  无兼容代码。
- **8.4 网络**：netSync 字段形状不变（仅值变小/变大），客户端 schema 手动副本
  无需改动；旧客户端解码不受影响（字段索引未变）。
- **8.5 感知半径未迁**：第一批后 perception 仍是 px（如 wolf 180px = 11.25 格），
  相对玩家新尺寸"视野显大"；观感确认时评估，第二批统一迁移。
- **8.6 归一化必须删除 `Tiles` 键**：残留键会被透传进运行时配置对象
  （虽被 `spawn.ts` 的"未知字段跳过"容忍），删除以保证冲突检测与配置面干净。
- **8.7 引用共享**：`normalizeTileUnits` 原地转换，注意 resolvedRules / archetype /
  behaviors 若存在共享引用，转换只应发生一次（接线处保证单次调用）。

---

## 9. 实施记录（完成后填写）

- [ ] Lane A 完成（A1-A4）
- [ ] Lane B 完成（B1-B4）
- [ ] §6 验证全过
- [ ] 观感确认（96s 横穿 / 0.5 格玩家）
- [ ] 第二批任务已开
