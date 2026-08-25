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
| 2 | **Colyseus 浏览器 SDK 经 CDN 引入**，锁定 0.17.x 大版本（如 `https://unpkg.com/colyseus.js@0.17/dist/colyseus.min.js`），与服务端 `@colyseus/core 0.17.x` 配套；全局对象 `Colyseus` 提供 `Client` |
| 3 | **Schema 类用纯 JS 方式声明**：`Schema` / `MapSchema` / `defineTypes()`（SDK 全局提供），**不用装饰器**（避免需要编译步骤）；类名/字段名/类型/**字段顺序**严格照抄协议 §3.4——字段顺序是线协议的一部分 |
| 4 | **渲染只用原生 Canvas 2D**：实体=色块（圆/矩形）+ 文字标签；禁止引入任何游戏引擎/框架 |
| 5 | **服务端地址可配置**：页面顶部输入框记住上次输入（localStorage），默认 `ws://localhost:3000`；HTTP 基址由它派生（`ws:`→`http:`，`wss:`→`https:`） |
| 6 | UI 与注释一律中文 |

---

## 2. 必须实现的客户端行为（按优先级）

### P0 连接与世界显示

1. `new Colyseus.Client(endpoint)` → `joinOrCreate("game")`，记 `room.sessionId`。
2. 自身实体 id：`state.players.get(room.sessionId)?.entityId`（uint32）。
3. **实体来源双通道兼容（见坑条款 K1）**：优先遍历自身 `PlayerState.visibleEntities`，回退 `state.entities`。
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

1. join 成功后：`GET {httpBase}/maps/runtime?mapId=` + `encodeURIComponent(room.state.mapId)`。
2. **校验**：响应 `id` 必须等于请求的 mapId，不符则控制台告警并拒绝应用。
3. 解码：每块 `data`（base64）→ `atob` → 逐字节写入 `blocked[(cy*16+r)*grid.width + cx*16+c]`；总长度应 = `width*height`，不符即报错。
4. 渲染：`blocked[i]===1` 的格子画半透明白色方块（尺寸 `grid.tileWidth/tileHeight`）。
5. 缓存：以 `{id, version}` 为键缓存已解码地图，命中则跳过拉取与重组。
6. 监听 `state.mapId` 变化 → 变化时重新执行 1-4（换图）。
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

左上角常驻：HP（Health.current）、hunger/thirst 条（Needs.0/1）、时钟（hour + phase 昼/夜）、mapId；
底部 12 格背包条（`Inventory.{i}.kind/count`，空槽灰显）；右上角任务列表（`Quest.*`，state 含义见协议 §4.7）。

---

## 3. ⚠️ 已知坑（违反任何一条都会“看似连上但显示不对”）

- **K1 visibleEntities 空 shell 回退**：受服务端已知上游 bug 影响（colyseus#935/#936，core 0.17.43），`visibleEntities` 可能解码“成功”但实体内容为空壳（`id` 不是数字）。**规则：表中存在至少一个 `typeof e.id === "number"` 的实体才使用 visibleEntities；否则回退遍历 `state.entities`**。注意：开启兴趣裁剪时**玩家自身实体只存在于 visibleEntities**，回退路径下自身状态会缺失属预期行为。服务端升级修复后本条可删除。
- **K2 seq 无需重传机制**：被拒输入（超速等）会被丢弃，客户端无法感知；只需保证 seq 严格递增、每次携带最新输入即可，后续输入自然覆盖，勿实现复杂重传。
- **K3 边沿触发**：键盘 `keydown` 有系统自动重复（auto-repeat），必须检查 `event.repeat` 过滤，否则 interact/attack/talk 会被连续触发。
- **K4 命令失败无回执**：所有命令失败（缺料/满包/距离不够）服务端零副作用且**不回复错误**。UI 不等待响应、不做乐观本地修改，一切以状态同步为准。
- **K5 CORS**：HTTP 端点受 `CORS_ORIGINS` 白名单限制（服务端默认 `http://localhost:5173`）。运行方式二选一：① 用任意静态服务器把页面跑在 `http://localhost:5173`（如 `npx serve -l 5173` 或 `python3 -m http.server 5173`）；② 在服务端 `.env` 设 `CORS_ORIGINS=<你的页面地址>` 后重启。
- **K6 房间级换图**：任一玩家踩传送门会导致**全房间**玩家换图（`mapId` 变化），多人时别人的画面突然切换属正常现象。
- **K7 权威模型**：服务端权威模拟，客户端**不做位移预测**，位置完全以同步状态为准（最小版直接读最新值渲染即可，不需要插值）。

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
9. 找到紫色传送门走进去 → `mapId` 变为 cave，地图重绘为 32×32 小图；走回传送门可返回。
10. 重启服务端后重连 → 位置/背包/任务基本恢复（60s 存档周期内的最后变更可能丢失）。

---

## 6. 版本记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v1 | 2026-08-25 | 首版。配套协议：`CLIENT-INTEGRATION.md`（含 chunked 地图契约 + `/maps/meta`）。服务端基线：@colyseus/core 0.17.43 / @colyseus/schema 4.0.25；兴趣裁剪开启（viewRadius=300）；存档周期 60s；注册表地图 generated-map(64×64) + cave(32×32)。K1 待服务端升级 colyseus ≥0.17.44 后复核移除 |
