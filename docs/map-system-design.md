# 地图系统设计补充建议

## 一、背景

本项目的世界由**配置驱动的生成管道**产出：地图配置声明一串生成步骤，每步是一个"生成积木"，按顺序执行，最终冻结为一份不可变的地图几何数据（`MapGeometry`）。

当前地图系统分五层：

- `geometry` — 不可变数据层：`tiles`（地形语义字节）、`walkable`（可通行位）、`regionOfTile`（区域索引）、`regions`（区域元数据），外加内容指纹 `version` 和 JSON 快照能力。
- `generate` — 生成层：注册表 + 有序管道，每个积木拿到独立的确定性随机流和自有参数。
- `evolution` — 演化层：按实体规则往地图上补差生成实体。
- `runtime` — 运行时编排：开机构建、出生点、时钟、离线补差。
- 另有换图与导出。

现有内置积木：噪声地形、气候区域、房间走廊、Tiled 导入。管道执行是**一次性线性**的：跑完所有生成积木就冻结。

## 二、现状的不足

1. **只有"生成"，没有"精修"**。生成完直接冻结，没有连通性整理、小区域剔除、平滑等收尾步骤。
2. **只有单通道**。一份地图只能表达"每格一个地形语义字节"，放不下高度、湿度、生物群系等额外维度；而且首个积木初始化尺寸后，后续积木无法再叠加新的场。
3. **区域统计没有统一约定**。区域元数据是一个自由字典，大小、质心、边界、形状指标等没有统一的派生规范。
4. **管道只跑一遍**。没有"反复施加局部规则直到稳定"这种收敛语义，平滑/修正类逻辑无处安放。
5. **校验只做结构**。只检查缓冲长度、区域索引越界等，不检查地图是否走得通、有没有不可达区域。

## 三、建议

### 1. 增加"生成后精修"阶段
在生成积木之后、冻结之前，允许挂一组"精修/分析积木"，例如连通性整理、小区域剔除、局部平滑。
**价值**：让"生成"和"打磨"职责分开，地图质量有地方收敛。
**影响**：管道层新增阶段概念；现有配置不受影响。
**实现方案**：不引入新的管道概念，精修积木就是普通积木，按顺序排在生成积木之后。新增积木放 `framework/map/generate/blocks/`（如 `smoothTerrain.ts`、`cullSmallRegions.ts`），导出 `MapGenerator` 签名的函数，在 `registerBuiltinMapGenerators` 里注册；配置侧在 `game/maps/registry.json` 的 `pipeline` 末尾追加步骤即可。如果希望配置上显式区分阶段，可给 `MapGenerationStep` 加可选 `stage?: "generate" | "refine"`，由管道执行器按阶段分组执行——属于可选增强，第一步可以不做。

### 2. 引入辅助通道
给地图草稿/几何数据增加可选的数据通道（如高度、湿度），并允许积木在已有草稿上继续写入，而不是被首个积木独占。
**价值**：支持多场叠加，是更丰富地形（山地、河流、生物群系）的前提。
**影响**：需同步修改快照、内容指纹、校验三处，属于较大的模型变更。
**实现方案**：给 `GeometryDraft` 和 `MapGeometry` 各加可选通道字段（如 `height?: Float32Array`，长度 = width × height、行主序）。改动点固定为：`generate/types.ts`（草稿定义 + `createGeometryDraft`）、`geometry/types.ts`（冻结几何）、`pipeline.ts`（冻结时原样移交）、`snapshot.ts`（快照的序列化/反序列化，类型化数组 ↔ number[]）、`version.ts`（`computeGeometryVersion` 的规范化对象纳入通道）、`validate.ts`（长度校验）。通道分配约定：核心缓冲仍由首个积木分配，辅助通道由需要它的积木按需分配（`if (!draft.height) draft.height = new Float32Array(width * height)`），这样多个场可以叠加，而不必让首个积木独占整份草稿。旧存档缺字段按缺省处理（项目现行约定是旧存档直接废弃，不写兼容代码）。

### 3. 区域统计做成派生层
为区域统一派生一组统计：大小、质心、边界、形状紧致度等，统一挂到区域元数据里。
**价值**：后续出生点、生物群系、地形筛选都能直接复用，不必各自重算。
**影响**：几何数据模型加一层约定，基本是增量。
**实现方案**：不新增数据类型，复用 `RegionMeta.meta`（`Record<string, unknown>`）。新增一个精修积木（如 `compute-region-stats`），遍历一次 `regionOfTile`，累积每区域的格数、坐标和（质心）、包围盒、边界格数等，写回 `regions.get(name).meta`。注意 `meta` 参与 `computeGeometryVersion` 的规范化序列化，统计写入会让内容指纹变化，属预期。若想类型明确，可在 `geometry/types.ts` 定义 `RegionStats` 供积木与消费方引用，`meta` 仍保持自由字典。

### 4. 有界收敛循环
在管道中支持一种"重复施加直到稳定"的执行语义，并设置最大轮数上限。
**价值**：平滑、连通性修正这类需要反复迭代的规则有标准的落点，同时避免死循环。
**影响**：管道执行器新增一种控制结构。
**实现方案**：先按最小实现，把迭代放在积木内部——例如 `smooth-terrain` 自己循环施加局部规则，参数带 `maxRounds`，某一轮没有变化就提前退出。这样不动管道和类型。若后续多个积木都需要收敛语义，再把 `MapGenerator` 返回类型从 `void` 扩展为 `void | boolean`（返回"本轮是否发生变更"，现有积木返回 `void` 视为 `false`，向后兼容），并在 `MapGenerationStep` 加 `repeat` 选项，由 `pipeline.ts` 负责循环到返回 `false` 或达到上限。

### 5. 连通性与质量校验
补一层软告警：检查可通行区域是否连通、是否存在不可达的孤立区域。
**价值**：把"地图能不能正常游玩"变成可检测项，而不是靠人工看图。
**影响**：校验层新增规则，不阻塞生成。
**实现方案**：在 `validate.ts` 增加软告警（不抛错）：对 `walkable = 1` 的格做一次 BFS 连通域标记，统计连通域数量与最大连通域占比，存在多个连通域或占比过低时 `logger.warn`。连通性是结构属性、不依赖游戏语义，符合校验器"纯结构、软告警不阻断"的定位，且只读现有字段，不需要新数据。阈值可先硬编码，需要时再给 `validateMapGeometry` 加可选参数。

### 6. noise-terrain 采样参数扩展（借鉴 gen-biome）

来源：对同路线小型库 `gen-biome` v3.0.5（github.com/neki-dev/gen-biome，值噪声 fBm → 高度分带 → 群系数据）的源码分析。只借鉴其参数化设计与公式，不引入依赖、不改管道模型；以下参数全部为可选项，缺省行为与现状完全一致。

#### 6.1 falloff 径向衰减（岛屿/大陆掩膜）
在 fBm 采样之后、分带量化之前，按"距边缘的归一化距离"衰减高度。gen-biome 的公式（分轴计算后相乘，四角衰减自然加倍）：`radius = 边长 / 2`，`distance = |radius - offset|`，`target = radius * (1 - falloff)`；`distance < target` 时不衰减，否则乘以 `1 - smootherstep((distance - target) / (radius * falloff))`，其中 `smootherstep(x) = 3x² - 2x³`。
**价值**：island 图现在的"岛"来自把低噪声带设为不可通行（`bandLevel=0.35` + `nonWalkableSemantics`），地形高度本身不向边缘沉降；falloff 让岛屿/大陆形态成为显式生成参数，海湾、半岛等地貌可稳定出现。
**影响**：仅 `noise-terrain` 积木内部新增一个可选参数分支，不动管道与数据模型；现有配置不受影响。
**实现方案**：新增可选参数 `falloff?: number`，入口校验 `0 ≤ falloff ≤ 0.9`（上限对齐 gen-biome），缺省 0 = 现状；应用点在 `sampleFbm` 返回后、band 扫描前；非法值抛错（fail-fast，不做静默 clamp）。参考实现：gen-biome `src/utils/perlin/index.ts:79-83, 104-122`。
**单测**：缺省时输出与现状逐字节一致；`falloff > 0` 时边缘/四角采样值统计上低于中心；同 seed 确定性不变。

#### 6.2 redistribution 高度曲线整形
分带前对采样值做指数重映射 `level **= exponent`。gen-biome 的 `heightRedistribution ∈ [0.5, 1.5]` 实测效果：0.5 时水域占比约 73%、1.5 时约 14%（默认 1.0 约 52%）。
**价值**：现在调整水域/陆地占比必须重排 `groundPalette` 全部阈值；一个指数参数即可整体平移占比，色表回归"语义切分"的单一职责。
**影响**：同 6.1，积木内参数分支；与 falloff 叠加时先 redistribution 后 falloff（与 gen-biome 顺序一致）。
**实现方案**：新增可选参数 `redistribution?: number`，入口校验 `[0.5, 1.5]`，缺省 1.0 = 现状；越界抛错。
**单测**：缺省一致；0.5 / 1.5 分别显著提高 / 降低最低带覆盖率；确定性。

#### 6.3 octaves / baseCellTiles 可配置化
把 `noiseTerrain.ts` 的常量 `OCTAVES = 4`、`BASE_CELL_TILES = 8` 暴露为可选参数（`GAIN = 0.5` 维持常量，对齐 gen-biome 同样固定 persistence）。gen-biome 的对应设计：倍频数 1–15（`borderSmoothness`，值越大边界越平滑）、基频以"整图格数"表达（1–32，`frequencyChange`，与地图分辨率无关）。
**价值**：不同尺寸/风格的地图可调噪声粒度与细节量（大图提高 octaves 保留细节，小图降低 octaves 避免碎斑），不必改框架代码。
**影响**：晶格构建按 `cell = baseCellTiles / 2^o` 递推，现逻辑不变、仅常量参数化；配置侧为可选字段。
**实现方案**：新增可选参数 `octaves?: number ∈ [1, 8]`（缺省 4）、`baseCellTiles?: number ∈ [2, 64]`（缺省 8）；入口校验抛错。
**单测**：缺省与现状一致；`octaves: 1` 单层输出；越界参数抛错路径；确定性。

#### 6.4 分析后不采纳的部分（记录结论，避免重复调研）
- **高度分带优先级**（gen-biome 的 peakBiome 插入序首匹配 + 双闭区间）：`groundPalette` 的严格校验（`bandLevel` = 最低带界、末位 = 1、错配抛错）优于 gen-biome 的静默空洞（群系不覆盖 [0,1] 时矩阵留下 undefined 洞），维持现状。
- **种子数组 + offsetX/offsetY 的 chunk 采样**：框架是固定尺寸、开机全图构建并冻结的模型，无限地图不在范围；未来若做 chunk 化再评估。
- **连通性整理、精修、收敛循环、区域统计**：gen-biome 无对应物，仍按本文件提案 1–5 执行。
- **反面印证**：gen-biome 的 `replaceAt` 无边界检查、参数静默 clamp、逐像素配置分配、零测试——与框架现行约定（不可变几何、fail-fast 校验、单测覆盖）方向一致，无需改动。

### 7. slot-rooms 槽位房间布局积木（借鉴 demo-e7ae1909）

来源：对同路线纯前端地牢 roguelike `demo-e7ae1909`（`js/dungeon.js:33-182`）的源码分析。其布局算法：固定槽位网格上的随机游走主路径 + 支线挂接，连通性由构造保证。

#### 7.1 demo 算法要点
- 5×4 槽位网格，每槽 15×12 tile，整图 75×48 tile；房间居中于槽位（普通 9-11×7-9，Boss 房 11×9），天然互不重叠。
- 主路径：从左缘随机行出发，每步向右（权重 2）/上/下，从不向左，到达右缘结束；路径房间依次标记 start → combat… → boss。
- 支线：最多 3 次尝试，从主路径中段房间（不含首尾）四向挂出，类型从 treasure/shop/shrine 洗牌后循环取（每种至多 1 个）。
- 走廊：相邻路径房、支线与源房的中心之间连 L 型走廊，宽 3 tile；墙体 = 一次八邻接 pass（非地板且邻地板变墙）；门 = 房间边界外一圈紧贴的地板格按方向合并成组。
- 精修：完全没有——无连通性整理、无小区域剔除、无平滑、无死胡同处理（支线房本身就是有意的死胡同）；连通性由"路径顺序连走廊 + 支线连源房"的构造保证。

#### 7.2 价值
与 room-corridor（自由挖房 + union-find 连通）互补的第二种布局风格：房间图结构确定、连通性由构造保证、每房产出结构化元数据（中心像素、门格列表、结构类型），后续出生点选择、演化刷怪（region 过滤）、传送门落点、房间级 gameplay 流程都能直接消费，不必各自重算。

#### 7.3 实现方案
- 新积木 `framework/map/generate/blocks/slotRooms.ts`，导出 `MapGenerator` 签名函数，在 `registerBuiltinMapGenerators` 注册；不新增管道概念，参数全走可选 params，缺省对齐 demo 值：
  - `slotsX?/slotsY?`（缺省 5/4，校验 ≥2）、`cellW?/cellH?`（缺省 15/12）、`roomMinW/roomMinH/roomMaxW/roomMaxH?`（缺省 9/7/11/9）、`bossRoomW/bossRoomH?`（缺省 11/9）、`corridorWidth?`（缺省 3，即 2w+1）、`branchCount?`（缺省 3，校验 ≤4）。
  - `roomTypes?: { pathFirst, pathLast, pathMid, branch: string[] }`——结构类型到语义名的映射，**缺省输出结构类型本身**（`path-first`/`path-last`/`path-mid`/`branch`）；demo 的 start/combat/boss/treasure/shop/shrine 属游戏语义，只能出现在 `game/maps/registry.json` 的配置里。
- 铁律对齐（与 demo 的关键差异）：demo 把敌人表/商店货/掉落硬编码进生成器（gen 期间直接调 `tableFor`/`roll`/`drop` 写全局数组），本框架不学——积木只产出 tiles + 每房一个 region（`regions` Map 插入序 = 房间序）+ region meta（`{ center: [px,py], halfW, halfH, doors: [[tx,ty]...], type: string }`）；内容填充全部留给 evolution EntityRule（region 过滤已支持）。
- 随机性沿用框架现有 xmur3 + mulberry32 的 `deriveStream`（seed + 步骤序号），**不引入 demo 的 LCG**（1664525/1013904223，仅单 32 位状态，质量低于现有实现）；demo 每层 `seed + floor*7919` 的派生思路与 `deriveStream` 等价，已覆盖。
- 参数入口 fail-fast 校验（越界抛错，不做静默 clamp）；写入草稿后由 pipeline 统一冻结，积木自身不做结构校验。
- **单测**（`framework/__tests__/map-block-slot-rooms.test.ts`）：同 seed 确定性（两次生成逐字节一致）；房间两两不重叠；连通域数 = 1（构造保证，BFS 断言）；门格均为地板且八邻接某个房间外圈；region meta 字段完整且中心在房间内；参数越界抛错路径。

#### 7.4 与本文其他提案的关系
- **不替代提案 5（连通性校验）**：槽位布局虽构造连通，但与噪声地形等其他积木组合、或后续精修积木介入后，仍可能产生孤立区域；软告警校验照常生效，两者互补。
- 属**生成积木**，与提案 1（精修阶段）正交；与提案 3（区域统计）叠加后，房间 region 可额外获得大小/质心等派生统计。
- gameplay 侧的配套（房间战斗流程、按房间类型刷怪）不在本文件范围，见 `docs/gameplay-features-design.md`。

---

**共同约定**：新积木遵守框架现有约定——不含游戏专属语义、参数在积木入口自行校验、每个积木配单测（`framework/__tests__/map-block-*.test.ts`）；配置改动后用 `pnpm tools validate` 校验。
