# 最小客户端生成规格（AI Client Generation Spec）

> **用途**：把本文件与同目录的 [`CLIENT-INTEGRATION.md`](./CLIENT-INTEGRATION.md)（协议契约）**一起完整导入**给任意 AI，
> AI 即可生成一个能连接本服务端、显示世界并收发操作的单文件网页客户端。
>
> **职责划分**：协议细节（消息格式/字段/数值）以 `CLIENT-INTEGRATION.md` 为唯一权威，本文件**不复述协议**；
> 本文件只规定「生成什么、怎么生成、验收什么」。协议变更时只更新协议文档，本文件仅在坑清单/约束变化时升版本。
>
> **使用方法**：两个文件一起粘贴给 AI；若工具一次只能导一个文件，将两份拼接后导入。

---

## 0. 给 AI 的任务指令（原样置于提示词最前）

你是一名资深 Web 游戏客户端工程师。请依据随附的《服务端对接协议》文档，生成一个**单文件 HTML 客户端**（index.html）：
打开后填入服务端地址即可连接，在浏览器中显示游戏世界并完成基础生存玩法操作。
代码质量要求：无构建步骤、无 npm 依赖、全部内联、中文注释与 UI。

---

## 1. 硬性技术约束

| # | 约束 |
|---|------|
| 1 | **单文件 index.html**：CSS/JS 全部内联；禁止任何构建工具/npm 包管理器 |
| 2 | **Colyseus 浏览器 SDK 经 CDN 引入，二选一（两条均浏览器实测通过）**：<br>**方式 A（pkg 官方 unpkg）**：① SDK 全局脚本 `<script src="https://unpkg.com/@colyseus/sdk@0.17.43/dist/colyseus.js">` → 全局 `window.Colyseus.Client`（与服务端 `@colyseus/core 0.17.43` 配套）；② Schema 模块 `<script type="module">import { Schema, MapSchema, defineTypes, type } from "https://unpkg.com/@colyseus/schema@4.0.25/build/index.mjs"</script>` → 模块作用域 `Schema`/`MapSchema`/`defineTypes`。<br>**方式 B（推荐——更简洁，importmap + jsdelivr `+esm`）**：先 `<script type="importmap">` 把 `@colyseus/sdk`/`@colyseus/schema` 映射到 jsdelivr `+esm`，再用 `import * as Colyseus from '@colyseus/sdk'`、`import { Schema, MapSchema, defineTypes } from '@colyseus/schema'`——`Colyseus.Client` 从模块导入、**不挂全局**；**importmap 必须放在所有 module script 之前**。完整写法见下方案例。<br>**⚠️ 禁止**用两个普通 `<script>` 标签分别加载 SDK 与 Schema（如 `<script src="...colyseus.js">` + `<script src="...colyseus-schema.js">`）——普通 script 无法解析裸导入/依赖关系，会报 `colyseus is not defined` / Schema 类未定义。**只能二选一：方式 A（全局脚本+模块导入配对）或方式 B（importmap+纯 ESM），绝不能拆分混用。**<br>**注意**：`colyseus.js` 包无 0.17.x（已改名 `@colyseus/sdk`）；无 `dist/colyseus.min.js`（真实文件是 `dist/colyseus.js`）；0.17 起 Schema 类**不挂** `window.Colyseus` 全局，须从模块导入 |
| 3 | **Schema 类用纯 JS 方式声明**（实测通过）：从 `@colyseus/schema` 模块导入 `Schema`/`MapSchema`/`defineTypes`，用 `defineTypes()`（**不用装饰器**，避免需要编译步骤）；类名/字段名/类型/**字段顺序**严格照抄协议 §3.4——字段顺序是线协议的一部分。完整可运行示例见本表下方 |
| 4 | **渲染只用原生 Canvas 2D**：实体=色块（圆/矩形）+ 文字标签；禁止引入任何游戏引擎/框架。**澄清：游戏引擎≠CSS 框架，Tailwind 不在此禁令范围**（见下表第 7 条） |
| 5 | **服务端地址可配置**：页面顶部输入框记住上次输入（localStorage），默认 `ws://localhost:3000`；HTTP 基址由它派生（`ws:`→`http:`，`wss:`→`https:`） |
| 6 | UI 与注释一律中文 |
| 7 | **Tailwind 仅用于 DOM 覆盖层 UI**：允许经 Play CDN `<script src="https://cdn.tailwindcss.com"></script>` 引入，用途=仅给 DOM 覆盖层（HUD/面板/按钮）做样式；**canvas 渲染不受影响**，也不作为游戏引擎/框架使用 |

### 约束 2/3 最小可运行示例 · 方式 A（直接复制，纯 JS，无构建；浏览器实测通过）

> 方式 A = SDK 全局脚本（`window.Colyseus.Client`）+ Schema 模块导入（`Schema`/`MapSchema`/`defineTypes`）配对。已作为基准，5 条连接断言实测 PASS。

```html
<!-- ① SDK 全局脚本（先加载；提供 window.Colyseus.Client） -->
<script src="https://unpkg.com/@colyseus/sdk@0.17.43/dist/colyseus.js"></script>
<!-- ② Schema 类（module scope；来自 @colyseus/schema） -->
<script type="module">
  import { Schema, MapSchema, defineTypes, type } from "https://unpkg.com/@colyseus/schema@4.0.25/build/index.mjs";

  // 三层 Schema 声明（纯 JS defineTypes，不用装饰器；字段名/类型/顺序严格照抄协议 §3.4）
  class EntityState extends Schema {}
  defineTypes(EntityState, {
    id:           "uint32",          // NetworkId
    values:       { map: "number" }, // 数值字段，"组件.字段"
    stringValues: { map: "string" }, // 字符串字段，"组件.字段"
  });

  class PlayerState extends Schema {}
  defineTypes(PlayerState, {
    sessionId:       "string",              // 自己的 sessionId
    entityId:        "uint32",              // 自己实体的 NetworkId
    mapId:           "string",              // 该玩家当前地图 id（per-player）
    visibleEntities: { map: EntityState },  // 视野内实体（唯一实体来源）
  });

  class RoomState extends Schema {}
  defineTypes(RoomState, {
    tick:     "uint32",                  // 逻辑帧号
    hour:     "float64",                 // 世界小时 0-24
    phase:    "uint8",                   // 0=白天 1=夜晚
    players:  { map: PlayerState },      // key=sessionId
  });

  // 连接：⚠️ 不要传自定义 Schema 类作第 3 参（见坑 K8），否则状态解码为空
  const client = new Colyseus.Client("ws://localhost:3001");
  const room   = await client.joinOrCreate("game");  // 不传 rootSchema
  console.log(room.sessionId, room.state.tick, room.state.players.get(room.sessionId).mapId);
</script>
```
**方式 A 已验证**：浏览器逐项实测 `window.Colyseus` 全局含 Client、模块导出 Schema 类可用，`joinOrCreate("game")` 成功（5/5 断言 PASS）。

---

### 约束 2/3 最小可运行示例 · 方式 B（推荐——importmap + jsdelivr `+esm`，纯 ESM；浏览器实测通过）

> 方式 B = 一个 `<script type="importmap">` 把两个包名映射到 jsdelivr `+esm`，再用两条 ESM `import`。`Colyseus.Client` 从 `@colyseus/sdk` 模块导入、不挂全局。**importmap 必须放在所有 module script 之前**（否则浏览器报 `Uncaught TypeError: Failed to resolve module specifier`）。

```html
<script type="importmap">
{
  "imports": {
    "@colyseus/sdk": "https://cdn.jsdelivr.net/npm/@colyseus/sdk@0.17.43/+esm",
    "@colyseus/schema": "https://cdn.jsdelivr.net/npm/@colyseus/schema@4.0.25/+esm"
  }
}
</script>
<script type="module">
  import * as Colyseus from '@colyseus/sdk';
  import { Schema, MapSchema, defineTypes } from '@colyseus/schema';

  // 三层 Schema 声明（纯 JS defineTypes，不用装饰器；字段名/类型/顺序严格照抄协议 §3.4）
  class EntityState extends Schema {}
  defineTypes(EntityState, {
    id:           "uint32",          // NetworkId
    values:       { map: "number" }, // 数值字段，"组件.字段"
    stringValues: { map: "string" }, // 字符串字段，"组件.字段"
  });

  class PlayerState extends Schema {}
  defineTypes(PlayerState, {
    sessionId:       "string",              // 自己的 sessionId
    entityId:        "uint32",              // 自己实体的 NetworkId
    mapId:           "string",              // 该玩家当前地图 id（per-player）
    visibleEntities: { map: EntityState },  // 视野内实体（唯一实体来源）
  });

  class RoomState extends Schema {}
  defineTypes(RoomState, {
    tick:     "uint32",                  // 逻辑帧号
    hour:     "float64",                 // 世界小时 0-24
    phase:    "uint8",                   // 0=白天 1=夜晚
    players:  { map: PlayerState },      // key=sessionId
  });

  // 连接：⚠️ 不要传自定义 Schema 类作第 3 参（见坑 K8），否则状态解码为空
  const client = new Colyseus.Client("ws://localhost:3001");
  const room   = await client.joinOrCreate("game");  // 不传 rootSchema
  console.log(room.sessionId, room.state.tick, room.state.players.get(room.sessionId).mapId);
</script>
```

**两段示例均浏览器实测通过**：方式 A（unpkg 全局+模块导入，5/5 断言 PASS）；方式 B（jsdelivr `+esm`，`joinOrCreate("game")` 后 tick 为正整数、玩家 `mapId="generated-map"` 非空〔历史实测记录，当时默认图为 generated-map；现默认图为 island〕，9/9 断言 PASS）。方式 B 之所以可行，是因为 jsdelivr `+esm` 会在**服务端**把裸导入改写为绝对 `/npm/...` 路径——这正好绕开浏览器直接 `import` `@colyseus/sdk/build/index.mjs` 时因裸导入 `@colyseus/shared-types` 而报 `Failed to resolve module specifier` 的坑（见坑 K8.4）。**坑 K8 对两种方式同样适用**：`joinOrCreate("game")` 不传自定义 rootSchema。

⚠️ **切勿用两个普通 `<script>` 标签分别加载 SDK 与 Schema**（例如 `<script src="...colyseus.js"></script>` + `<script src="...colyseus-schema.js"></script>`）——普通 script 无法解析裸导入/依赖关系，会报 `colyseus is not defined` / Schema 类未定义。**二选一**：方式 A（全局脚本+模块导入）或方式 B（importmap+纯 ESM），绝不能拆分混用。

---

## 2. 必须实现的客户端行为（按优先级）

### P0 连接与世界显示

1. `new Colyseus.Client(endpoint)` → `joinOrCreate("game")`，记 `room.sessionId`。
2. 自身实体 id：`state.players.get(room.sessionId)?.entityId`（uint32）。
3. **实体来源（见坑条款 K1）**：只遍历自身 `state.players.get(room.sessionId).visibleEntities`（唯一实体来源；`state` 的 `entities` 已随协议移除）。
4. 按协议 §3.6 特征辨识实体种类，配色渲染：

   | 种类 | 判定特征 | 颜色 | 标签 |
   |------|----------|------|------|
   | 自己 | id === 自身 entityId | 青色 + 高亮圈 | 你 |
   | 其他玩家 | Health + Needs | 青色 | 👤 |
   | 敌怪 | 仅 Health | 红色 | 敌 |
   | NPC | DialogueSource.treeId | 绿色 | NPC |
   | 资源点 | ResourceNode.remaining | 棕色 | 剩余量 |
   | 地面物品 | ItemMeta.kind | 黄色 | kind |
   | 火堆 | CraftingStation.stationType + LightSource | 橙色 | 🔥 |
   | 传送门 | Portal.targetMap | 紫色 | 门 |
   | 建筑 | Placeable.* | 灰色 | — |

5. 形状：`Collider.shape` 0=圆（用 `radius`）、1=矩形（用 `Size.w/h`）；缺省按半径 8 圆处理。`Transform.x/y` 是**中心**坐标。

### P1 地图加载

1. join 成功后：`GET {httpBase}/maps/runtime?mapId=` + `encodeURIComponent(room.state.players.get(room.sessionId).mapId)`。
2. **校验**：响应 `key` 必须等于请求的 mapId，不符则控制台告警并拒绝应用。
3. 解码：直接读响应的 `walkable` 数组（纯 JSON number[]，行主序，长度 = `width*height`，索引 = `y*width+x`）；**无 base64、无分块重组**。长度不符即报错。
4. 渲染：`walkable[i]===0` 的格子画半透明白色方块（尺寸 `grid.tileWidth/tileHeight`）。⚠️ 语义与旧版 chunked `blocked` 位图**相反**：0=阻挡，1=可走。
5. 缓存：以 `{key, version}` 为键缓存地图（`version` 与响应头 `x-map-version` 同值），命中则跳过拉取。
6. 监听 `state.players.get(room.sessionId).mapId` 变化 → 变化时重新执行 1-4（该玩家换图）。
7. 相机：平移画布使自身实体居中（不做边界钳制也可）。

### P2 输入

1. WASD → `moveX/moveY`（像素/秒，幅度 ≤200，斜向归一化到 ≤200）。
2. 每 **50ms** 发送一次 `input`（携带当前方向快照）；`seq` 从 1 起严格递增。
3. `E`=interact、`Space`=attack、`T`=talk：**仅按下事件那一帧置 true**，其余帧 false（见坑条款 K3）。

### P3 操作命令（消息名 `"command"`，形状见协议 §2.2）

| 输入 | 行为 |
|------|------|
| 数字键 `1`-`9`,`0`,`-`,`=` | 选中背包槽 0-11（高亮） |
| `F` | 对选中槽：食物→`consume`；工具→`equip` |
| `G` | 丢弃选中槽（`drop`） |
| `C` | 开关合成面板：列出协议 §4.4 全部配方按钮，点击发 `{type:"craft",recipe}` |
| `B` | 放置选中 kit：目标点 = 自身坐标 + 面板方向 × 32px，发 `{type:"place",slot,x,y}` |
| `X` | 拆除最近建筑（从实体表找最近 `Placeable.*`，发 `{type:"deconstruct",target}`） |
| 对话选项 | 自身实体存在 `Dialogue.{i}.option` 时渲染按钮列表，点击发 `{type:"dialogue",option:i}` |

### P4 状态 HUD

左上角常驻：HP（Health.current）、hunger/thirst 条（Needs.0/1）、时钟（hour + phase 昼/夜）、mapId（该玩家当前地图）；
底部 12 格背包条（`Inventory.{i}.kind/count`，空槽灰显）；右上角任务列表（`Quest.*`，state 含义见协议 §4.7）。

---

## 3. ⚠️ 已知坑（违反任何一条都会“看似连上但显示不对”）

- **K1 visibleEntities 空 shell 兜底**：受服务端已知上游 bug 影响（colyseus#935/#936，core 0.17.43），`visibleEntities` 可能解码“成功”但实体内容为空壳（`id` 不是数字）。`visibleEntities` 是**唯一**实体来源（`state` 的 `entities` 已随协议移除，**没有回退通道**）。**规则：表中存在至少一个 `typeof e.id === "number"` 的实体才使用 visibleEntities；若解码为空壳，客户端应视为无可见实体**（不再有任何实体表回退）。注意：此场景下**玩家自身实体只存在于 visibleEntities**，空壳时自身状态缺失属预期行为。服务端升级修复后本条可删除。
- **K2 seq 无需重传机制**：被拒输入（超速等）会被丢弃，客户端无法感知；只需保证 seq 严格递增、每次携带最新输入即可，后续输入自然覆盖，勿实现复杂重传。
- **K3 边沿触发**：键盘 `keydown` 有系统自动重复（auto-repeat），必须检查 `event.repeat` 过滤，否则 interact/attack/talk 会被连续触发。
- **K4 命令失败无回执**：所有命令失败（缺料/满包/距离不够）服务端零副作用且**不回复错误**。UI 不等待响应、不做乐观本地修改，一切以状态同步为准。
- **K5 CORS**：HTTP 端点受 `CORS_ORIGINS` 白名单限制（服务端默认 `http://localhost:5173`）。运行方式二选一：① 用任意静态服务器把页面跑在 `http://localhost:5173`（如 `npx serve -l 5173` 或 `python3 -m http.server 5173`）；② 在服务端 `.env` 设 `CORS_ORIGINS=<你的页面地址>` 后重启。
- **K6 换图改为 per-player**：玩家踩传送门只切换**该玩家自己**的地图（其 `players.get(room.sessionId).mapId` 变化），其他玩家的 `mapId` 不受影响、画面不切换——不再有房间级全员换图。
- **K7 权威模型**：服务端权威模拟，客户端**不做位移预测**，位置完全以同步状态为准（最小版直接读最新值渲染即可，不需要插值）。
- **K8 引入与 rootSchema 实测坑**（下列任何一条都会“看似连上但状态不对”或直接崩）：
  1. **勿传自定义 rootSchema**：`client.joinOrCreate("game", {}, RoomState)`（第 3 参传入客户端 `RoomState` 类）实测**状态解码为空**（`tick`/`mapId`/`players`/`entities` 全 `undefined`）——客户端用预实例化的 `RoomState` 做解码，而服务端反射/增量补丁没落到该实例。**正确：`joinOrCreate("game")`（不传第 3 参）**，由服务端反射自动解码，字段完整。客户端 `Schema/defineTypes` 声明仅作协议文档/校验用，勿作为 rootSchema 传入。
  2. **`colyseus.js` 包无 0.17.x**：已改名 `@colyseus/sdk`；且任何版本都**没有** `dist/colyseus.min.js`（真实文件是 `dist/colyseus.js`）。
  3. **0.17 起 Schema 类不挂 `window.Colyseus` 全局**：`Schema`/`MapSchema`/`defineTypes` 必须从 `@colyseus/schema` 模块导入（候选 `colyseus.js@0.16.22` 文件文本确有 `exports.Schema`，但运行时 `window.Colyseus` 键里并没有）。
  4. **SDK 的 ESM 入口浏览器直载失败**：`@colyseus/sdk@0.17.43/build/index.mjs` 含 `@colyseus/schema`/`@colyseus/shared-types` 裸导入，浏览器报 `Failed to resolve module specifier`；须用 `dist/colyseus.js` 全局版，或经 importmap（方式 B）让 CDN 服务端把裸导入改写为绝对 `/npm/...` 路径。
  5. **旧版浏览器直接崩**：`colyseus.js@0.15.28` 加载即抛 `Buffer is not defined`（`window.Colyseus` 是空 `{}`）；`0.16.22` 全局并不暴露 Schema 类。此两者均不可用。
  6. **（方式 B 专用）importmap 位置**：`<script type="importmap">` **必须放在所有 module script 之前**，且一个页面**只能有一个** importmap；两个 module script 里重复贴 importmap 会报错。importmap 只影响裸名称解析，不影响方式 A（全局脚本+模块直导入）的正确性。

---

## 4. 明确不做（防止 AI 过度发挥）

美术资源/精灵动画/音频、客户端预测与插值平滑、断线自动重连与指数退避、移动端触控、国际化、单元测试、打包优化。
检测到自己在实现以上任何一项时立即停止。

---

## 5. 验收清单（生成完成后逐项自检，全过才算交付）

1. 页面打开 → 填默认地址连接成功 → 画布出现阻挡块网格与若干实体色块，HUD 显示 HP/饥饿/口渴/时钟。
2. WASD 移动流畅，松手即停（位置来自服务器同步）。
3. 走近树/浆果丛按 `E` → 背包出现木材/浆果。
4. 按 `Space` 攻击附近野猪 → 其消失前可见；掉落物走近自动拾取入包。
5. 走近村民按 `T` → 出现对话框与选项按钮 → 点接任务选项 → 任务面板出现条目。
6. `C` 打开合成面板 → 合成斧头（木材×2）成功入包；`F` 装备后采集速度提升。
7. 吃浆果（选中+F）→ 饥饿度回升。
8. 选中火堆套件按 `B` → 身前出现火堆实体（橙色）；`X` 可拆除自己放置的建筑。
9. 找到紫色传送门（island tile (54,42)）走进去 → 该玩家 `mapId` 变为 cave（`players.get(room.sessionId).mapId`），地图重绘为 64×64 小图；走 cave 的回程门（tile (32,32)）可返回 island。
10. 重启服务端后重连 → 位置/背包/任务基本恢复（60s 存档周期内的最后变更可能丢失）。

---

## 6. 版本记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v1 | 2026-08-25 | 首版。配套协议：`CLIENT-INTEGRATION.md`（含 chunked 地图契约 + `/maps/meta`）。服务端基线：@colyseus/core 0.17.43 / @colyseus/schema 4.0.25；兴趣裁剪开启（viewRadius=300）；存档周期 60s；注册表地图 generated-map(64×64) + cave(32×32)。K1 待服务端升级 colyseus ≥0.17.44 后复核移除 |
| v1.1 | 2026-08-25 | CDN/导入写法修正（`colyseus.js`→`@colyseus/sdk@0.17.43` 全局版 + `@colyseus/schema@4.0.25` 模块导入，浏览器实测通过）；新增 Tailwind 条目（§1 约束表第 7 条）；新增坑 K8（自定义 rootSchema 传参即空状态等 5 条实测坑）。约束 2/3 改掉原先写错的双重错误地址与“全局提供 Schema 类”的说法；K1-K7 复核后表述保持成立未改 |
| v1.2 | 2026-08-25 | 约束 2 写法升级：明确**两种实测可行的引入方式**（方式 A：unpkg 全局脚本+Schema 模块导入 / 方式 B：importmap + jsdelivr `+esm`），新增**「禁止两个普通 script 混用」警告**以消除 AI 生成 `colyseus is not defined` 的歧义；最小示例保留方式 A 基准并**新增方式 B 完整可复制示例**（均标注浏览器实测通过）；坑 K8 补第 6 条（方式 B 专用 importmap 位置）并改写 K8.4 说明方式 B 如何绕开裸导入坑 |
| v1.3 | 2026-08-31 | 地图契约改版（地图系统重设计后）：chunk 化阻挡位图废弃，`/maps/runtime` 改为全图快照 `tiles`/`walkable`/`regions`/`regionOfTile` + `x-map-version` 响应头；响应标识字段 `id`→`key`；默认图 generated-map→island；cave 32×32→64×64；`/maps/meta` 的 `kind` 改为管道首积木名（`generatorId`/`seed` 字段移除）。§P1 地图加载步骤 2-5 与验收清单第 9 步同步改写；§1 示例段 `mapId="generated-map"` 为历史实测记录（已就地标注，不改写实测日志） |
