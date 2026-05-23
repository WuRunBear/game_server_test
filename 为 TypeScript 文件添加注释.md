# 为 TypeScript 文件添加注释

> **Workspace:** g:\wrbtest\game

---

## User
`g:\wrbtest\game\src\map\generated\simple.ts` 加上注释

## Assistant
已在 [simple.ts](file:///g:/wrbtest/game/src/map/generated/simple.ts) 中补充中文注释，包含：

- `xorshift32` 的函数级中文 JSDoc（含 `@param` / `@returns`）
- `SimpleGeneratorOptions` 的接口说明与各字段含义
- `generateSimpleMap` 的函数级中文 JSDoc（含 `@param` / `@returns`）
- 关键流程的分段说明（边界阻挡初始化、随机障碍投放、默认出生点）

## User
大概解析一下这项目的地图系统

## Assistant
已对 `g:\wrbtest\game\src` 下与地图相关的目录（`src/map/**`）、启动入口（`src/main.ts`）、配置加载（`src/config/map.ts` + `config/maps.registry.json`）、ECS World/系统编排、碰撞/网络系统做了全量检索与交叉定位；下面给出“核心文件清单 + 运行流程概览”。

**核心文件（按职责）**
- **地图系统入口（装载到 World）**：[main.ts](file:///g:/wrbtest/game/src/main.ts#L13-L36)
- **地图配置/选择 MapSource**：[map.ts](file:///g:/wrbtest/game/src/config/map.ts#L74-L142)、[maps.registry.json](file:///g:/wrbtest/game/config/maps.registry.json#L1-L14)
- **地图模块统一出口**：[index.ts](file:///g:/wrbtest/game/src/map/index.ts#L1-L9)
- **MapRuntime/MapSource 类型定义**：[types.ts](file:///g:/wrbtest/game/src/map/types.ts#L1-L172)
- **把 MapSource 构建为 MapRuntime**：[buildRuntime.ts](file:///g:/wrbtest/game/src/map/buildRuntime.ts#L1-L25)
- **Tiled JSON → MapRuntime（collision/objects/zones 解析约定）**：[tiled.ts](file:///g:/wrbtest/game/src/map/tiled.ts#L1-L220)
- **程序生成器（generated 目录）**：[simple.ts](file:///g:/wrbtest/game/src/map/generated/simple.ts#L1-L93)
- **World 挂载 map/net**：[world.ts](file:///g:/wrbtest/game/src/world.ts#L20-L26)
- **ECS 系统顺序（与地图“间接关联”的位置）**：[systems/index.ts](file:///g:/wrbtest/game/src/systems/index.ts#L13-L28)
- **实体碰撞（当前只做实体-实体，不吃 blocked）**：[collisionSystem.ts](file:///g:/wrbtest/game/src/systems/core/collisionSystem.ts#L47-L164)
- **网络快照/广播（当前不下发地图）**：[snapshotSystem.ts](file:///g:/wrbtest/game/src/systems/network/snapshotSystem.ts#L7-L31)、[broadcastSystem.ts](file:///g:/wrbtest/game/src/systems/network/broadcastSystem.ts#L3-L17)、[server.ts](file:///g:/wrbtest/game/src/network/server.ts#L41-L119)、[protocol.ts](file:///g:/wrbtest/game/src/network/protocol.ts#L1-L32)

**地图系统入口与运行流程（加载/生成 → 挂到 ECS World）**
- **进程启动后**在 [main.ts](file:///g:/wrbtest/game/src/main.ts#L13-L36) 中完成：
  - `world.map = buildMapRuntime(getMapSourceFromConfig())`（地图装载入口）[main.ts](file:///g:/wrbtest/game/src/main.ts#L24-L33)
  - 随后用 `world.map.spawns` 创建玩家与 NPC 初始实体（地图目前“实际被消费”的关键点）[main.ts](file:///g:/wrbtest/game/src/main.ts#L28-L33)
- **地图来源选择（MapSource）**：
  - `getMapSourceFromConfig()` 固定读取 `config/maps.registry.json` 并选择 `default`（当前默认 `generated-map`）[map.ts](file:///g:/wrbtest/game/src/config/map.ts#L139-L142)、[maps.registry.json](file:///g:/wrbtest/game/config/maps.registry.json#L1-L14)
- **MapSource → MapRuntime**：
  - `buildMapRuntime(source)`：`tiled` 走 `mapRuntimeFromTiled`，`generated` 走 `generateSimpleMap` [buildRuntime.ts](file:///g:/wrbtest/game/src/map/buildRuntime.ts#L11-L25)

**MapRuntime / 类型结构（你要找的“MapRuntime/类型”入口）**
- `MapRuntime` 定义在 [types.ts](file:///g:/wrbtest/game/src/map/types.ts#L74-L102)，核心字段：
  - `grid`: `{ width,height,tileWidth,tileHeight }`
  - `blocked: Uint8Array`：按 `width*height` 展平；`0=可走，1=阻挡`
  - `spawns`: `{ player: Vec2|null, npcs: [{kind,pos,zoneId?}] }`
  - `zones`: `MapZone[]`（多边形区域）
- `MapSource` 是 `GeneratedMapSource | TiledMapSource` [types.ts](file:///g:/wrbtest/game/src/map/types.ts#L104-L172)

**blocked（地图阻挡）怎么来、目前怎么用**
- **来源 1：程序生成**（generated）
  - `generateSimpleMap()`：边界一圈强制阻挡 + 内部约 5% 随机障碍 [simple.ts](file:///g:/wrbtest/game/src/map/generated/simple.ts#L40-L93)
- **来源 2：Tiled 导入**（tiled）
  - 只认名为 `collision` 的 `tilelayer`：`data[i] != 0` 视为阻挡并写入 `Uint8Array` [tiled.ts](file:///g:/wrbtest/game/src/map/tiled.ts#L87-L105)
- **当前消费情况（重要结论）**
  - 代码中目前**没有任何系统读取 `world.map.blocked`**（全仓仅在生成/解析时写入 blocked）。
  - 当前碰撞系统 [collisionSystem.ts](file:///g:/wrbtest/game/src/systems/core/collisionSystem.ts#L47-L164) 使用 `check2d` 只处理**实体碰撞体之间**的分离回写，不包含“地形/地图阻挡”静态碰撞。

**generated 目录（生成器入口）**
- 生成器目录：`src/map/generated/`
- 当前仅一个生成器实现：`simple` → [simple.ts](file:///g:/wrbtest/game/src/map/generated/simple.ts#L1-L93)
- 生成器选择方式目前是“配置里 `kind: generated` 时固定 `generatorId: "simple"`”（没有动态注册表）[types.ts](file:///g:/wrbtest/game/src/map/types.ts#L107-L116)、[map.ts](file:///g:/wrbtest/game/src/config/map.ts#L116-L128)

**地图加载/切换（现状）**
- **加载**：只在启动时加载一次（`main()` 里写 `world.map = ...`），没有运行中 reload/切换逻辑 [main.ts](file:///g:/wrbtest/game/src/main.ts#L24-L33)
- **切换**：仓库内未发现 `switchMap/changeMap/loadMap` 等地图切换实现；`world.map` 也只是可选字段挂载在 World 上 [world.ts](file:///g:/wrbtest/game/src/world.ts#L20-L26)

**与 ECS / 渲染 / 网络的关联**
- **ECS（直接关联点）**
  - 地图数据被挂到 `GameWorld.map?: MapRuntime` [world.ts](file:///g:/wrbtest/game/src/world.ts#L20-L26)
  - 启动时用 `spawns` 创建初始实体（玩家/NPC）[main.ts](file:///g:/wrbtest/game/src/main.ts#L28-L33)
  - 系统编排与 tick 驱动不依赖地图：系统链在 [systems/index.ts](file:///g:/wrbtest/game/src/systems/index.ts#L16-L28)，主循环在 [gameLoop.ts](file:///g:/wrbtest/game/src/gameLoop.ts#L24-L67)
- **渲染**
  - `src` 内未发现渲染相关模块/依赖（这是 headless 服务端结构）；`MapRuntime` 也不包含“tile 可视层/tileset”等渲染必需数据。
- **网络**
  - 网络协议目前只同步实体快照（位置/血量等），不包含地图数据 [protocol.ts](file:///g:/wrbtest/game/src/network/protocol.ts#L19-L32)
  - 服务器连接时也不会推送 map（`startNetworkServer` 只管收 input、广播 snapshot）[server.ts](file:///g:/wrbtest/game/src/network/server.ts#L79-L101)、[snapshotSystem.ts](file:///g:/wrbtest/game/src/systems/network/snapshotSystem.ts#L10-L29)

（补充）仓库里有一份较长的链路说明文档可作旁证/背景阅读：[\梳理项目运行链路.md](file:///g:/wrbtest/game/%E6%A2%B3%E7%90%86%E9%A1%B9%E7%9B%AE%E8%BF%90%E8%A1%8C%E9%93%BE%E8%B7%AF.md)（其中部分链接指向旧工作区路径，但对“模块职责/思路”仍可参考）。

**整体结构**
- 地图系统核心目标：把“地图来源（配置/Tiled/程序生成）”统一转换成一个运行时结构 `MapRuntime`，并挂到 `world.map` 上供游戏逻辑使用。
- 入口在 [main.ts](file:///g:/wrbtest/game/src/main.ts#L13-L36)：启动时构建地图并立刻用 `world.map.spawns` 生成玩家/NPC 实体。

**核心数据结构（MapRuntime）**
- 类型定义在 [types.ts](file:///g:/wrbtest/game/src/map/types.ts#L74-L102)，关键字段：
  - `grid`：网格尺寸与 tile 像素尺寸
  - `blocked: Uint8Array`：长度 `width * height`，`1=阻挡，0=可走`
  - `spawns`：玩家/NPC 出生点（像素坐标）
  - `zones`：区域（多边形）列表

**地图来源与构建流程**
- 地图来源 `MapSource` 分两类：[types.ts](file:///g:/wrbtest/game/src/map/types.ts#L104-L172)
  - `generated`：程序生成
  - `tiled`：从 Tiled JSON 解析
- 配置选择在 [config/map.ts](file:///g:/wrbtest/game/src/config/map.ts#L74-L142) + [maps.registry.json](file:///g:/wrbtest/game/config/maps.registry.json#L1-L14)，当前是读取 registry 并选 `default`（默认指向 `generated-map`）。
- 统一构建入口：[buildRuntime.ts](file:///g:/wrbtest/game/src/map/buildRuntime.ts#L1-L25)
  - `kind: tiled` → `mapRuntimeFromTiled`
  - `kind: generated` → `generateSimpleMap`

**blocked（地形阻挡）怎么来的**
- 程序生成：`generateSimpleMap()` 里“边界一圈阻挡 + 内部随机 5% 障碍” [simple.ts](file:///g:/wrbtest/game/src/map/generated/simple.ts#L23-L59)
- Tiled：只认名为 `collision` 的 `tilelayer`，`data[i] != 0` 视为阻挡 [tiled.ts](file:///g:/wrbtest/game/src/map/tiled.ts#L87-L105)

**目前地图在运行时怎么被用（重要现状）**
- 目前地图数据最直接的消费点是“生成初始实体”：`main.ts` 里用 `world.map.spawns` 创建玩家和 NPC [main.ts](file:///g:/wrbtest/game/src/main.ts#L24-L33)
- 目前代码里还没有系统去读取 `world.map.blocked` 做“角色-地形”的静态碰撞；现有碰撞系统主要是“实体-实体”分离 [collisionSystem.ts](file:///g:/wrbtest/game/src/systems/core/collisionSystem.ts#L47-L164)

**加载/切换与网络/渲染关系**
- 加载：只在启动时加载一次，没有运行中切换地图的实现（未发现 `switchMap/loadMap` 之类逻辑），`world.map` 只是挂在 [world.ts](file:///g:/wrbtest/game/src/world.ts#L20-L26)
- 网络：协议/快照只同步实体，不下发地图数据 [protocol.ts](file:///g:/wrbtest/game/src/network/protocol.ts#L1-L32)
- 渲染：当前仓库更像 headless 服务端结构，`MapRuntime` 也不携带 tileset/可视层等渲染信息

如果你想让我继续“按你预期的玩法”深入（比如：要做基于 `blocked` 的寻路/移动限制，或要支持地图切换并同步给客户端），告诉我你希望地图在玩法里承担哪些职责，我再按目标把缺的系统/接口补齐并给出改造点位。

## User
生成的地图格式是怎么样的

## Assistant
生成的地图在这个项目里有两层“格式”：

**1）生成器的输入格式（GeneratedMapSource）**
- 类型在 [types.ts](file:///g:/wrbtest/game/src/map/types.ts#L104-L145)
- 结构大概是：

```ts
{
  kind: "generated",
  generatorId: "simple",
  id: string,
  name: string,
  seed: number,
  width: number,      // tile 数
  height: number,     // tile 数
  tileWidth: number,  // 像素
  tileHeight: number  // 像素
}
```

这份结构通常来自配置（registry），然后在 [buildRuntime.ts](file:///g:/wrbtest/game/src/map/buildRuntime.ts#L11-L25) 里被送进具体生成器。

**2）生成器的输出格式（MapRuntime，也就是“运行时地图格式”）**
- 类型在 [types.ts](file:///g:/wrbtest/game/src/map/types.ts#L74-L102)
- `simple` 生成器返回的就是这个结构（见 [simple.ts](file:///g:/wrbtest/game/src/map/generated/simple.ts#L46-L59)）：

```ts
{
  id: string,
  name: string,
  grid: {
    width: number,
    height: number,
    tileWidth: number,
    tileHeight: number,
  },
  blocked: Uint8Array,  // 长度 = width * height，0 可走，1 阻挡
  spawns: {
    player: { x: number, y: number } | null,    // 像素坐标
    npcs: Array<{ kind: string, pos: { x: number, y: number }, zoneId?: number }>
  },
  zones: Array<{ id: number, name: string, polygon: Array<{x:number,y:number}> }>
}
```

**blocked 的索引规则（很关键）**
- `blocked` 是按一维数组存的：`index = y * width + x`
- 其中 `x,y` 是 tile 坐标（0 到 width-1 / height-1），不是像素坐标
- `simple` 里会把边界一圈设为 1，然后随机撒一些内部障碍（也设为 1）[simple.ts](file:///g:/wrbtest/game/src/map/generated/simple.ts#L27-L39)

如果你希望我用“某个具体配置（比如 default 那张）”把生成出来的 `MapRuntime` 打印一个实际样例（包含 blocked 前几十格、spawns 等），我也可以直接帮你跑一段小脚本把结果输出出来。

## User
也就是按照MapRuntime的格式生成？

## Assistant
对，就是按照 `MapRuntime` 的格式生成（更准确说：最终进入游戏运行逻辑的地图统一都要被“构建成”一个 `MapRuntime`）。

- 程序生成（generated）：生成器函数（比如 [generateSimpleMap](file:///g:/wrbtest/game/src/map/generated/simple.ts#L23-L59)）直接 `return MapRuntime`
- Tiled 导入（tiled）：先拿到 Tiled JSON（`unknown`），再由 [mapRuntimeFromTiled](file:///g:/wrbtest/game/src/map/tiled.ts#L189) 解析并组装成 `MapRuntime`
- 两种来源最后都走同一个入口 [buildMapRuntime](file:///g:/wrbtest/game/src/map/buildRuntime.ts#L11-L25)，对外只产出 `MapRuntime`

所以你只要理解 `MapRuntime` 这套结构，就能覆盖“程序生成”和“Tiled 导入”两条链路。

## User
这个MapRuntime有扩展的必要吗

## Assistant
要不要扩展 `MapRuntime`，取决于它在你项目里的定位：它现在更像“服务端运行时最小地图数据”，目前实际被消费的基本只有 `spawns`（启动时刷实体）以及“潜在可用但尚未用起来”的 `blocked`。

**结论（按现状）**
- 如果你短期目标只是“跑起来 + 刷怪 + 简单移动/实体碰撞”，`MapRuntime` 暂时不需要扩展，甚至当前字段都有点“偏预留”（比如 `blocked` 还没被系统读取）。
- 只有当你明确要做某些地图驱动玩法/客户端渲染/地图切换同步时，扩展才有必要；否则扩展只会增加解析成本和后续维护面。

**什么时候“有必要”扩展**
- **要做地形碰撞/寻路**：需要一个明确的“可走性/代价”表达（现在只有 `blocked 0/1`，如果要泥地减速、道路加速、不同碰撞类型，就需要扩展为 cost/flag 或多层网格）。
- **要做传送门/地图切换**：需要 `portals/links`（目标地图 id、目标坐标、触发条件），以及可选的 `defaultSpawn`/`spawnPoints` 命名体系。
- **要做区域触发/脚本**：`zones` 可能要带 `properties`（触发类型、参数、一次性/循环、冷却等），仅 `id/name/polygon` 不够。
- **要支持客户端渲染（Tiled 可视层）**：需要保存 tilelayer 的 `data`、tileset 引用、layer 顺序/可见性等；当前 `MapRuntime` 明显不包含这些信息，属于“渲染侧缺数据”。
- **要做网络同步校验**：需要地图 `version/hash`，方便客户端确认自己加载的是同一张地图（现在协议里也没发 map）。

**推荐的扩展方式（尽量不把核心弄重）**
- 保持 `MapRuntime` 的核心字段稳定（`grid/blocked/spawns/zones`），只在“确定有消费者”的时候加字段。
- 如果你预期玩法会分化，优先加一个可选的承载结构而不是把字段平铺到顶层，例如：
  - `meta?: Record<string, unknown>`（轻量通用元信息）
  - 或者按模块拆：`navigation?`、`portals?`、`triggers?` 这种可选块
  - 避免为了某一个玩法把所有地图都背上解析/存储成本。

你现在更偏向哪条路线？
- 只做服务端逻辑（地形阻挡 + 刷怪 + 传送/区域触发）
- 还是要把 Tiled 的可视层也纳入（给客户端渲染用）

你选一个方向，我可以按目标给出“最小必要字段集”，并指出应该改动解析器（`tiled.ts`）还是生成器（`generated/*`）以及系统消费点应该放哪里。

## User
tiled的碰撞层是怎么做的？

## Assistant
tiled 的“碰撞层”在这个项目里是用一个**专门的 tilelayer**来做的，名字必须叫 `collision`，然后把这个图层的 tile data 转成 `MapRuntime.blocked`。

**你在 Tiled 里要怎么画**
- 新建一个图层：类型是 Tile Layer（tilelayer）
- 图层名称：必须是 `collision`
- 在这个图层里：
  - 你想让某个格子“不可走/阻挡”，就给它放任意一个 tile（gid 非 0）
  - 空格（gid 为 0）表示可走

**代码里怎么解析**
- 解析逻辑在 [parseCollision](file:///g:/wrbtest/game/src/map/tiled.ts#L93-L105)
- 行为要点：
  - 只会去找 `l.type === "tilelayer" && l.name === "collision"` 的图层 [tiled.ts](file:///g:/wrbtest/game/src/map/tiled.ts#L95-L97)
  - 如果找不到该图层，或该图层没有 `data`，就返回全 0（全可走）[tiled.ts](file:///g:/wrbtest/game/src/map/tiled.ts#L99)
  - 生成 `Uint8Array(width * height)`，逐格写入：
    - `collision.data[i]` 为真（非 0）→ `blocked[i] = 1`
    - 否则 `blocked[i] = 0` [tiled.ts](file:///g:/wrbtest/game/src/map/tiled.ts#L101-L104)
  - 下标 `i` 的规则等价于 `i = y * width + x`（一维展开）

**注意点**
- 它不关心你放的是什么 tile，只看 `data` 是否为 0，所以这是一个“二值碰撞层”（可走/不可走），不支持不同碰撞材质或代价。
- 当前仓库里 `blocked` 主要是数据层准备好了，但还没有看到系统实际用它做“角色-地形碰撞/寻路”。如果你要做这一块，需要再加消费逻辑。

## User
为什么是tilelayer，而不是objectgroup？

## Assistant
因为这个项目的“碰撞”最终要落到 `MapRuntime.blocked: Uint8Array(width * height)` 这种**按格子对齐的二值网格**上；用 `tilelayer` 和它的 `data` 数组，天然就是“每个格子一个值”，转换成本最低、运行时查询最快。

**用 tilelayer 的直接好处**
- **一一对应网格**：Tiled 的 `tilelayer.data` 本身就是 `width*height` 的线性数组，解析时只要 `data[i] != 0 → blocked[i]=1`（你现在看到的实现就是这么做的）。
- **运行时访问 O(1)**：移动/寻路/碰撞检测时，给定 tile 坐标 `(x,y)` 直接 `blocked[y*width+x]` 就能判定，不需要几何计算。
- **编辑成本低**：画阻挡就是“刷格子”，不会出现缝隙、重叠、对齐误差等问题。

**为什么不用 objectgroup**
- `objectgroup` 更适合放**稀疏、形状化**的东西（区域、多边形、触发器、传送门、刷怪点）。如果用它做碰撞：
  - 运行时要做“点/圆/盒 与 多边形/矩形集合”的几何判断，或额外再做一次“栅格化”把对象转换回 blocked 网格
  - 编辑时需要保证对象完美对齐网格，否则会出现“看起来挡住但实际没挡住/反之”的边界问题
- 这项目其实已经把 `objectgroup` 用在更合适的地方了：`zones`、`objects`（出生点）都是 objectgroup（见 [tiled.ts](file:///g:/wrbtest/game/src/map/tiled.ts#L113-L179)）。

**什么时候 objectgroup 更合适来做碰撞**
- 你想要**非网格**的碰撞（斜坡、多边形墙体、圆形障碍）
- 你想要**更少的地图数据**（对象很少，完全没必要存整张 `width*height` 网格）
- 你需要**不同材质/类型**的碰撞体（比如 one-way、可破坏、伤害区），对象属性更好表达

按你现在的 `MapRuntime.blocked` 设计，选择 `tilelayer` 是最贴合的数据结构。如果你准备把阻挡升级成“多边形/复杂碰撞”，那才值得把碰撞来源改成（或兼容）`objectgroup`。

## User
如果要实现环世界(RimWorld)那种效果呢？

## Assistant
如果你说的“环世界那种效果”是指：大地图、全 tile 化、地形/墙体/门/家具都参与寻路与遮挡、房间识别、温度与通风、雾战、分区加载、各种地面材质与移动代价……那结论基本是：

- 仍然以“网格（tile）”为核心，不会改成用 `objectgroup` 来表达主要碰撞
- 但需要把现在的 `MapRuntime(blocked 0/1)` 升级成“多层网格 + 规则驱动”的运行时地图

**为什么 RimWorld 仍是 tile 为主**
- RimWorld 的绝大多数玩法都依赖“每格一个状态”：地表类型、是否有墙/门、是否有屋顶、是否可站立、移动代价、可视遮挡、温度交换、污染/肥沃度等。用 tile 网格能做到 O(1) 查询和高效批处理。
- `objectgroup` 更适合“少量、稀疏、形状化”的内容（触发区、多边形区域），不适合承载全图级的可走性与材质系统。

**你现在这套 MapRuntime 需要怎么升级（方向）**
- **从二值 blocked → 多通道网格**
  - `blocked` 只能表示“走/不走”，但 RimWorld 需要：
    - `terrainId`（地表类型：草地、泥地、石地…）
    - `structureId` 或 `edifice`（墙/门等占格建筑）
    - `roof`（屋顶遮挡/室内判定）
    - `walkable`/`passability`（可通行等级：不可走/可走/只能小体型等）
    - `moveCost`（移动代价）
    - `opacity`/`blocksSight`（视线遮挡）
- **从“整图一个数组”→ 分块（chunk）**
  - RimWorld 那类玩法通常要大地图 + 高频更新；把全图做成单数组也能行，但更常见是按 chunk（比如 32x32 或 64x64）组织，方便：
    - 局部重算（放墙/拆墙只影响附近）
    - 局部同步（网络/存档）
    - 局部缓存（寻路、可视、温度）
- **加入“区域/房间/连通性”缓存层**
  - RimWorld 的很多系统不是每次都做全图 flood fill，而是维护“区域图/房间图”（Region/Room）：
    - 放置或移除一个阻挡物时，增量更新房间连通、室内外判定
    - 寻路也会用 region graph 加速长距离查询
- **寻路需要从“blocked 判断”升级为“代价 + 动态障碍”**
  - A* 不只看能不能走，还要看 moveCost、门的开关、危险区、角色体型/权限等。
  - 动态实体（小人）通常不写进静态网格，而是作为“临时阻塞/软阻塞”参与寻路/碰撞。

**对你当前项目的最小落地建议（按投入递增）**
- **阶段 1：在不大改结构的前提下**
  - 保留 `MapRuntime.grid`
  - 把 `blocked: Uint8Array` 扩成 `passability: Uint8Array`（0/1/2…）或 `flags: Uint32Array`（位标记）
  - 新增 `moveCost: Uint8Array`（或者 terrainId → 查表得 cost）
  - 先把“角色-地形碰撞/移动限制”做起来（目前你仓库里 blocked 数据没被消费）
- **阶段 2：开始接近 RimWorld 的“规则驱动”**
  - 引入 `terrainId`、`structureId`（以及对应的 defs 表：不同地面/建筑的属性）
  - 做基础的“房间识别/室内外”（基于 `blocksSight`/`isWall` 之类）
- **阶段 3：性能与可扩展**
  - chunk 化 + region graph + 增量更新
  - 可视系统/雾战、温度与气体、火灾蔓延等

**关于 Tiled：还要不要用？**
- RimWorld 那套玩法通常更像“程序生成 + 规则系统”，Tiled 更适合作为：
  - 关卡模板/测试地图
  - 美术可视层（如果你有客户端渲染）
  - 手工摆放特殊点（出生点、剧情触发、地标）
- 真正的地形/建筑/材料体系，建议走“ID 网格 + defs”而不是把逻辑塞在 Tiled 图层里。

你说的“RimWorld 效果”更偏哪一块优先？
- A：地形材质 + 移动代价 + 寻路（最核心）
- B：房间/屋顶/室内外
- C：雾战与视线遮挡
- D：温度/通风/火灾这种模拟系统

你选 1–2 个优先目标，我可以按你现有代码结构给一套“最小字段扩展 + 系统消费点应该放哪里 + Tiled/生成器怎么出数据”的具体改造方案。

