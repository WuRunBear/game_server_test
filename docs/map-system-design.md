# 地图系统设计补充（已实现记录）

> **状态**：本文档已与实现同步（提交 5c5f1d1；aux 槽位池见提交 b35dd1f），后续以代码为准。

## 一、背景

本项目的世界由**配置驱动的生成管道**产出：地图配置声明一串生成步骤，每步是一个"生成积木"，按顺序执行，最终冻结为一份不可变的地图几何数据（`MapGeometry`）。

当前地图系统分五层：

- `geometry` — 不可变数据层：`tiles`（地形语义字节）、`walkable`（可通行位）、`regionOfTile`（区域索引）、`regions`（区域元数据），外加内容指纹 `version` 和 JSON 快照能力。
- `generate` — 生成层：注册表 + 有序管道，每个积木拿到独立的确定性随机流和自有参数；积木间的非地理中间产物经 aux 槽位池传递（见第三节）。
- `evolution` — 演化层：按实体规则往地图上补差生成实体。
- `runtime` — 运行时编排：开机构建、出生点、时钟、离线补差。
- 另有换图与导出。

内置积木现为九个（`framework/map/generate/registerBuiltin.ts` 注册）：`noise-terrain`、`climate-regions`、`room-corridor`、`tiled-source`、`region-stats`、`smooth-terrain`、`height-channel`、`height-mask`、`slot-rooms`。管道执行仍是**一次性线性**：按声明顺序跑完所有积木即冻结，没有阶段概念。

## 二、当时的不足（已全部解决）

本文档前身为设计提案，动机是以下五条不足，现均已落地：

1. **只有"生成"，没有"精修"**。生成完直接冻结，没有连通性整理、小区域剔除、平滑等收尾步骤。→ 已由 `smooth-terrain`、`region-stats` 两个后处理积木解决（见 4.1、4.3、4.4；小区域剔除未实现）。
2. **只有单通道**。一份地图只能表达"每格一个地形语义字节"，且首个积木初始化尺寸后，后续积木无法再叠加新的场。→ 已由 aux 槽位池解决（见第三节）。
3. **区域统计没有统一约定**。→ 已由 `region-stats` 解决（见 4.3）。
4. **管道只跑一遍**。→ 已按最小实现解决：收敛迭代放在积木内部（见 4.4），管道层未加控制结构。
5. **校验只做结构**。→ 已由可通行连通性软告警解决（见 4.5）。

## 三、公共基础：aux 槽位池

对应原提案 2（辅助通道）的落地形态（提交 b35dd1f）。原提案方案是给 `GeometryDraft` 与 `MapGeometry` 各加可选通道字段并同步修改快照、指纹、校验三处；实际**未采纳**，替换为"暂存池"形态：辅助数据不进冻结几何，`MapGeometry` 类型保持不变，三处改动随之不需要。

**落点**：`framework/map/generate/types.ts`。

- `GeometryDraft.aux: Map<string, unknown>` — 积木间结构化中间产物暂存池（`createGeometryDraft` 初始化为空池）。
- `AuxSlot<T>` — branded 槽位键：`name` + `brand` 品牌字段，不同 `T` 的槽位在结构类型检查下互不兼容，跨槽写入编译期报错（运行时品牌字段不参与行为）。
- `defineAuxSlot<T>(name)` 声明槽位常量；`setAux(draft, slot, value)` 写入（同槽覆盖旧值）；`getAux(draft, slot)` 读取（未写入返回 `undefined`）。

**生命周期约定**：aux 仅存在于 `buildMapGeometry` 执行期——**冻结即弃**。防泄漏是结构性保证：`framework/map/generate/pipeline.ts` 冻结处显式挑字段构造 `MapGeometry`（key/grid/tiles/walkable/regions/regionOfTile/version），`aux` 不在其类型图上，因此天然不进快照、不参与内容指纹（`computeGeometryVersion`）与出口校验。

**槽位约定**：名称格式 `"<积木名>.<产物>"`；框架不预置任何槽位，槽位常量由各积木自带导出，协作积木双方引用同一常量。当前两个：`HEIGHT_FIELD = "height-channel.field"`（`Float64Array`，见 4.2）、`SLOT_ROOMS = "slot-rooms.rooms"`（`SlotRoomInfo[]`，见 4.7）。

**测试**：`framework/__tests__/map-generate-aux.test.ts`（生命周期与冻结无泄漏、branded 编译期隔离 `@ts-expect-error` 断言、写 aux 不改变内容指纹）；`framework/__tests__/map-aux-height-channel.test.ts`（管道串接后冻结产物无 aux 泄漏）。

## 四、已实现能力

### 4.1 生成后精修积木（原提案 1）

不引入管道阶段概念，精修积木就是普通积木，按顺序排在生成积木之后，配置侧在 `game/maps/registry.json` 的 `pipeline` 末尾追加步骤即可。原提案的可选增强 `stage?: "generate" | "refine"` 未实现（无真实需求牵引）；示例中的小区域剔除积木也未实现。已落地的精修/分析积木：

- `smooth-terrain`（地形平滑，见 4.4）— `framework/map/generate/blocks/smoothTerrain.ts`；
- `region-stats`（区域统计，见 4.3）— `framework/map/generate/blocks/regionStats.ts`。

### 4.2 辅助通道积木 height-channel / height-mask（原提案 2 的验证实现）

多场叠加能力的验证对：生产者在 aux 写入 height 场，消费者读 aux 落回地理缓冲。注册名 `height-channel` / `height-mask`。

**height-channel**（`framework/map/generate/blocks/heightChannel.ts`）：

- 向 aux 槽位 `HEIGHT_FIELD` 写入 height 场（`Float64Array`，行主序，长度 = width × height，值 ∈ [0, 1)）：单层值噪声生成，晶格随机值取自本步骤派生流，双线性 + smoothstep 插值采样，同 seed 同 params 确定复现。
- 参数：`cell?: number`（晶格间距 tile 数，正数，缺省 8，非正数抛错）。
- 只写 aux、不动 tiles/walkable/regions；要求草稿已定尺寸（sizing 积木先行，否则抛错）。

**height-mask**（`framework/map/generate/blocks/heightMask.ts`）：

- 参数：`mode: "mask" | "stats"`（必填，非法值抛错）；`minLevel?/maxLevel?`（∈ [0, 1]，缺省 0/1，须 min ≤ max 否则抛错）。
- `mode: "mask"`：按高度闭区间重写 walkable — 场值 ∈ [minLevel, maxLevel] → 1，否则 0。
- `mode: "stats"`：按 regionOfTile 汇总每有覆盖区域的平均高度，写入 `RegionMeta.meta.averageHeight`。
- 上游依赖 fail-fast：aux 无 height 场或长度不符即抛错（点名依赖的 `height-channel`）。

**测试**：`framework/__tests__/map-aux-height-channel.test.ts`（场形态与确定性、mask/stats 行为、上游缺失抛错、管道串接与无 aux 泄漏）。

### 4.3 区域统计 region-stats（原提案 3）

**落点**：`framework/map/generate/blocks/regionStats.ts`，注册名 `region-stats`。未新增数据类型：统计直接写入各区域 `RegionMeta.meta`（自由字典），随冻结带入 `MapGeometry` 并参与内容指纹（统计写入改变指纹，属预期）。

单次遍历 `regionOfTile`，为每个**有覆盖**的区域写（坐标均为 tile 坐标）：

- `meta.area` — 区域格数（number）；
- `meta.centroid` — `[cx, cy]` 格坐标均值（浮点）；
- `meta.bounds` — `{ minX, minY, maxX, maxY }` 最小包围盒（含端点）。

参数：`metrics?: ("area" | "centroid" | "bounds")[]` — 缺省三项全写；提供时须为非空数组、条目全部合法（未知项抛错），重复条目去重。零覆盖区域跳过（不写任何统计键）；meta 同名旧键被覆盖。要求草稿已定尺寸且 regionOfTile 索引合法（否则抛错）。

**测试**：`framework/__tests__/map-block-region-stats.test.ts`（三项数值正确性、metrics 筛选、零覆盖跳过、旧键覆盖、参数校验）。

### 4.4 有界收敛循环（原提案 4）

按原提案的最小实现：迭代放在积木内部，管道与类型未动（`MapGenerator` 仍返回 `void`，无 `repeat` 选项，管道级收敛语义未实现）。

**落点**：`framework/map/generate/blocks/smoothTerrain.ts`，注册名 `smooth-terrain`。局部多数平滑：

- 每轮对每格统计「自身 + 4-邻域」共 5 格的语义众数，最高频语义（并列取语义 id 最小，保证确定性）出现次数严格大于自身语义次数时改写该格；double-buffer 同步更新（整轮基于同一快照）。
- 定点收敛：`maxRounds?: number`（整数 ≥ 0，缺省 8）为轮数上限，某轮零变更即提前退出；输出恒为平滑算子不动点或恰好 maxRounds 轮后的状态（有界，不依赖收敛性）。
- `nonWalkableSemantics?: number[]`：提供时平滑结束后按最终 tiles 重派生 walkable（∈ 集合 → 0，否则 1），保证语义 → 通行一致；不提供时 walkable 原样保留。
- 导出 `smoothRound(tiles, width, height)` 纯函数（单轮算子，返回 `[新缓冲, 变更格数]`）。

**测试**：`framework/__tests__/map-block-smooth-terrain.test.ts`（单轮算子行为与平局规则、不动点、maxRounds 截断与 `maxRounds=0`、缺省 = 8、重派生、管道接入）。

### 4.5 可通行连通性软告警（原提案 5）

**落点**：`framework/map/generate/validate.ts`。对 `walkable = 1` 格做 4-邻接 BFS 连通域标记（`walkableDomains`，模块私有，返回 [域数, 最大域格数]）：

- 无可通行格（walkable 全 0）→ 软告警；
- **存在多个连通域且最大域占比低于阈值** → 软告警（消息含域数与最大域占比百分比）；
- 阈值经 `ConnectivityCheckOptions.minMainDomainShare`（∈ [0, 1]）可配置，缺省为导出常量 `DEFAULT_MIN_MAIN_DOMAIN_SHARE = 0.9`；设为 1.0 退化为"多域即告警"。

`validateMapGeometry(input, options?)` 返回全部软告警消息列表（供调用方测试/上报），日志照常逐条 `logger.warn`（scope `"build-map"`）；结构硬错误照旧抛错。管道执行器 `buildMapGeometry` 调用时恒用缺省阈值。与原提案告警条件的差异及原因见第五节 1。

**测试**：`framework/__tests__/map-validate-connectivity.test.ts`（单域无告警、多域告警不抛错、阈值上下两种行为、全图不可通行、软告警不影响硬错误路径、冻结几何同样适用）。

### 4.6 noise-terrain 采样参数（原提案 6，借鉴 gen-biome 的参数化设计）

**落点**：`framework/map/generate/blocks/noiseTerrain.ts`（注册名 `noise-terrain` 不变）。四个可选参数全部在积木入口 fail-fast 校验（越界/类型错误抛错点名参数，不 clamp）；**缺省行为与旧版逐位一致**（缺省 = 现状）：

| 参数 | 取值范围 | 缺省 | 作用 |
|------|---------|------|------|
| `falloff` | number ∈ [0, 0.9] | 0 = 关闭 | 径向掩膜：采样值按距边缘的归一化距离衰减 |
| `redistribution` | number ∈ [0.5, 1.5] | 1 = 现状 | 分带前指数重映射 `level = level ** exponent`，整体平移各带覆盖率（调整占比不必重排 `groundPalette`） |
| `octaves` | integer ∈ [1, 8] | 4 | fBm 叠加层数 |
| `baseCellTiles` | integer ∈ [2, 64] | 8 | 基频晶格间距（tile 数，逐层减半） |

应用顺序：fBm 采样后先 `redistribution` 后 `falloff`，再进入 band 扫描——不影响 `bandLevel` / `groundPalette` 的既有校验语义。`GAIN = 0.5` 维持固定常量。

falloff 实现：`d = 最近边距 / (短边之半)`（边缘 0、中心 1）的**单值径向掩膜**——`d ≤ 1 − falloff` 的内圈不衰减，越靠外经五次 smootherstep（`6d⁵ − 15d⁴ + 10d³`）平滑趋零；四角不额外加倍衰减。与原提案引用的 gen-biome 公式的差异及原因见第五节 2。

**测试**：`framework/__tests__/map-block-noise-terrain.test.ts`（缺省与显式缺省值逐位一致、恒值场精确断言、真实随机场统计断言、同 seed 确定性、越界抛错）。

### 4.7 slot-rooms 槽位房间布局（原提案 7，借鉴 demo-e7ae1909 的布局算法）

**落点**：`framework/map/generate/blocks/slotRooms.ts`，注册名 `slot-rooms`。

**sizing 首积木**：整图尺寸由槽位网格决定（width = `slotsX × cellW`，height = `slotsY × cellH`），本积木必须是管道首积木（草稿已初始化即抛错）；tiles 全部初始化为 `solidTile`、walkable 全 0。与原提案的差异见第五节 3。

**结构**（连通性由构造保证：主路径顺序连走廊 + 支线连源房；房间互不重叠由槽位划分 + 房尺寸 ≤ 槽尺寸 − 1 的校验保证）：

- **主路径**：从左缘随机行出发的随机游走，每步向右（权重 2）或上/下、从不向左，到达右缘结束——主路径房间数恒 = slotsX，类型依次 `path-first` → `path-mid`… → `path-last`（末房用固定大尺寸 `lastRoomW × lastRoomH`，首中段房尺寸在 [roomMin*, roomMax*] 随机、槽内居中）。
- **支线**：至多 `branchCount` 次尝试，从主路径中段房间（不含首尾）向四方向空槽挂出，类型从 `roomTypes.branch` 序列循环取用（slotsX < 3 时无支线）。
- **走廊**：主路径相邻房间之间、支线房与源房之间连 L 形走廊（中心到中心，先横/先竖随机），厚 `corridorWidth`（向左/上偏移居中），走廊格归属出发房区域；已是地板的格（走廊穿越其他房间）保持原区域归属。
- **区域与元数据**：每房一个 region（名 `"<type>#<序号>"`，插入序 = 主路径序 → 支线序），未雕挖格归属末尾的 `"walls"` 结构区域（导出常量 `WALLS_REGION`）；每房 meta = `{ center: [px, py], halfW, halfH, doors: [[tx, ty]...], type }`（中心/半宽为像素；门 = 房间外环一 ring 的 walkable 连续段取中位格）。
- **aux 导出**：房间矩形列表 `SlotRoomInfo[]`（x/y/width/height/slotX/slotY/type/regionIndex）经槽位 `SLOT_ROOMS` 供下游积木消费（仅管道执行期，冻结丢弃）。

**参数**（全部 fail-fast 校验，越界抛错点名参数）：

| 参数 | 约束 | 缺省 |
|------|------|------|
| `slotsX` / `slotsY` | 整数 ≥ 2 | 5 / 4 |
| `cellW` / `cellH` | 整数 ≥ 2 | 15 / 12 |
| `roomMinW` / `roomMinH` | 整数 ≥ 1 | 9 / 7 |
| `roomMaxW` / `roomMaxH` | 整数 ∈ [roomMin*, cell*−1] | min(11, cellW−1) / min(9, cellH−1) |
| `lastRoomW` / `lastRoomH` | 整数 ∈ [1, cell*−1] | 11 / 9 |
| `corridorWidth` | 整数 ≥ 1 | 3 |
| `branchCount` | 整数 ∈ [0, 4] | 3 |
| `roomTypes` | `{ pathFirst?, pathLast?, pathMid?, branch?: string[] }`，非空字符串（数组） | 输出结构类型名本身 |
| `floorTile` / `solidTile` | [0, 255] 整数且不相等（必填） | — |
| `tileWidth` / `tileHeight` | 正数（必填） | — |

结构类型名（`path-first`/`path-mid`/`path-last`/`branch`）是纯结构描述；语义命名由配置 `roomTypes` 传入，框架不解释字符串内容（framework 无游戏语义铁律）。与 demo 的其余差异：随机性沿用框架 `deriveStream`（xmur3 + mulberry32，seed + 步骤序号），未引入 demo 的 LCG；demo 把敌人/商店/掉落硬编码进生成器的做法不采纳——积木只产出 tiles + region + meta，内容填充留给 evolution EntityRule（region 过滤已支持）。

**测试**：`framework/__tests__/map-block-slot-rooms.test.ts`（同 seed 逐位一致、尺寸换算与全参数化、房间不重叠、连通域 = 1 的 BFS 断言、meta 齐全、roomTypes 映射、参数越界与非首积木抛错）；`framework/__tests__/map-block-register.test.ts`（`slot-rooms → smooth-terrain → region-stats` 组合管道端到端）。

## 五、实现与原设计的差异

1. **连通性告警条件**（4.5）：原提案为"存在多个连通域**或**占比过低"；实现为"多域**且**最大域占比 < 阈值"（`minMainDomainShare` 可配置，缺省 0.9，设 1.0 退化回"多域即告警"）。原因：正常噪声图常有大湖/海湾造成的孤立可通行域，"多域即告警"会在正常图上持续刷告警，失去信号价值。
2. **falloff 公式**（4.6）：原提案引用 gen-biome 的分轴计算后相乘（四角衰减自然加倍）与三次曲线（原文将其记作 smootherstep，实为 smoothstep）；实现为"最近边距 / 短边之半"的单值径向掩膜 + 五次 smootherstep（`6d⁵ − 15d⁴ + 10d³`，两端导数为零）。原因：单值径向语义更直（衰减强度只取决于距最近边缘的距离）且实现更简单；五次曲线边缘过渡更平滑。
3. **slot-rooms 尺寸归属与命名**（4.7）：原提案未指定整图尺寸来源（沿用"首个积木定尺寸"的既有约定但未挑明）；实现为 **sizing 首积木**（整图尺寸 = 槽位网格换算，必须是管道首积木）。demo 的 `boss`/`start` 等游戏词改为结构类型名 `path-first`/`path-mid`/`path-last`，参数 `bossRoomW/H` 相应改名 `lastRoomW/lastRoomH`（首房无独立尺寸参数，用 `roomMin*/roomMax*` 随机区间）；结构类型名只输出结构描述，语义命名经配置 `roomTypes` 传入——framework 无游戏语义铁律。

## 六、gen-biome 调研不采纳记录（历史结论，避免重复调研）

- **高度分带优先级**（gen-biome 的 peakBiome 插入序首匹配 + 双闭区间）：`groundPalette` 的严格校验（`bandLevel` = 最低带界、末位 = 1、错配抛错）优于 gen-biome 的静默空洞（群系不覆盖 [0,1] 时矩阵留下 undefined 洞），维持现状。
- **种子数组 + offsetX/offsetY 的 chunk 采样**：框架是固定尺寸、开机全图构建并冻结的模型，无限地图不在范围；未来若做 chunk 化再评估。
- **连通性整理、精修、收敛循环、区域统计**：gen-biome 无对应物，已按本文第三节、4.1–4.5 落地。
- **反面印证**：gen-biome 的 `replaceAt` 无边界检查、参数静默 clamp、逐像素配置分配、零测试——与框架现行约定（不可变几何、fail-fast 校验、单测覆盖）方向一致，无需改动。

---

**共同约定**：生成积木遵守框架现有约定——不含游戏专属语义、参数在积木入口自行校验（fail-fast，不做静默 clamp）、每个积木配单测（`framework/__tests__/map-block-*.test.ts`）；配置改动后用 `pnpm tools validate` 校验，`pnpm tools list-registries` 可查看当前注册积木。
