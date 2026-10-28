# 配置编辑器可视化改造计划（配置编辑器 ↔ 本体仓协作）

> 目标：把 excalibur_test 平台的配置编辑器从「Monaco 直接编辑 JSON」升级为可视化表单（输入框/下拉/开关），支持便捷地选择添加本体框架功能（systems）、管理本体 src 自定义扩展，并对每个功能、每个参数显示介绍。
> 分工：**本体仓改动（本文件主体）由本体仓维护者实施**；平台侧改动在 excalibur_test 内实施，此处仅列出对接契约。
> 可行性已由 spike 验证：`excalibur_test/scripts/spike-jsdoc-schema.mts`，16/16 验证点通过、零丢失，报告在 `excalibur_test/docs/spike-jsdoc-schema-report.md`。

---

## 0. 架构总览（已定方案）

```
本体仓（事实源）                      平台 sidecar（excalibur_test）              编辑器前端
────────────────                    ──────────────────────────                ─────────────
framework/config/schema/*.ts   →    driver 启动时：                             ConfigView 双模式
  zod schema（校验/结构）              ts-morph 读本体 schema 源码前导 JSDoc        ├ 表单模式（默认）
  前导 JSDoc（参数/功能介绍）  →        → 与运行时 zod shape 双侧对齐              │  schema 驱动 + 定制 widget
register*() 调用（功能介绍）   →        → z.registry() 构建描述注册表（缓存）      └ Monaco 源码模式（兜底）
src/register.ts 自定义扩展    →      getSchema RPC → z.toJSONSchema + registry
                                     listRegistries RPC → 元数据
```

核心机制（spike 确认）：
- **描述源 = 前导 JSDoc 注释**，zod 保持唯一结构/校验事实源，不写 `.describe()`、不引入注释解析常驻管线。
- `.meta()` 会克隆实例、无法事后挂到已加载 schema 上 → 必须用 **`z.registry()` + `z.toJSONSchema(schema, { metadata: registry })`** 按实例身份注入。
- 解析与注入只发生在 sidecar 启动时一次，缓存复用；改注释重启 sidecar 生效，无构建期步骤。

---

## 1. 本体仓改动清单（按依赖顺序）

### Phase A1：注释规范（契约，先行）

配置 schema 的字段介绍统一写**前导 JSDoc**，规则：

1. 每个字段独立一条注释，**禁止组合 bullet**（如 `/** id、name：定义标识与显示名 */` 会让 spike 的对齐器给多字段挂同一描述）。需共用背景时可写两条并各自成句。
2. 注释只写**文字介绍**；数值约束（min/max/default/枚举）一律留在 zod 校验链（`z.number().min(0)`），由 `toJSONSchema` 自动转成 JSON Schema 关键字，不在注释里重复。
3. 注释必须挂在字段声明所在行之前（`z.object({...})` 实参内的 PropertyAssignment 前导位置）。
4. 已知现状问题需修正：存在文档块错位（如合成配方 bullet 挂在 `RecipeInputSchema` 声明上），按规则 1/3 归位。

### Phase A2：现有 schema 注释补全

范围（对齐 `excalibur_test/server/sidecar/driver.ts:166-175` 的 SCHEMA_TABLE + 整体校验用到 schema 的文件）：

| 文件 | 现状（spike 统计） | 目标 |
|---|---|---|
| `framework/config/schema/GameDefinitionSchema.ts` | 28 字段 / 26 注入（含子 schema 引用场景） | 补 `tickRate` 等缺失项，拆组合 bullet |
| `framework/config/schema/RuleSchema.ts`（combat/needs/crafting/daynight/server） | crafting 10 字段 / 3 注入 | 补齐 5 个 rule schema 全字段 |
| `framework/config/schema/MapRegistrySchema.ts` | 10 / 8（discriminatedUnion 两分支已通） | 补齐 |
| `framework/config/schema/ArchetypeSchema.ts` | 5 / 5 | components 值为 unknown，注释只到键级别 |
| `ItemKindSchema.ts` / `DialogueSchema.ts` / `QuestSchema.ts` / `EcosystemsSchema.ts` / `PlayerRuleSchema.ts` / `BehaviorSchema.ts` | 未纳入 spike | 按同规范补全（整体校验消费它们） |

`maps/entity-rules.json` 对应的 `framework/map/evolution/schema.ts` 一并纳入。

### Phase A3：register*() 元数据扩展（框架功能与 src 自定义的介绍来源）

扩展 `framework/api.ts:29-81` 的注册签名，增加可选/条件必填元数据：

```ts
registerSystem('weather', {
  description: '天气系统：…',            // 功能介绍，编辑器「添加框架」面板直接展示
  configSchema: z.object({ ... }),       // 有 config 时必填；字段用前导 JSDoc 写介绍
  setup(world) { ... },
})
```

适用全部注册点：`registerSystem` / `registerComponent` / `registerArchetype` / `registerAction` / `registerRuleModule` / mapGenerator / `registerSpawnCondition` / `registerEffect` / `registerTrigger`。

规则：
- **有 config 的注册，configSchema 必填**；无 config 可省略。防作弊守卫：注册入口（或 `tools/validate`）检测 configSchema 的 JSON Schema 输出中是否出现 passthrough/unknown 宽松形态，出现即警告或拒绝注册。
- `registerComponent` 的 configSchema 是填平 `entities/*.json` components 不透明区（`ArchetypeSchema.ts:16` 为 `z.unknown()`）的钥匙，39 个实体文件的可视化编辑依赖它。

### Phase A4：内置系统/组件补元数据

- `framework/bootstrap/registerBuiltinSystems.ts:37-165`（21 个内置系统）按 A3 签名补 `description`；目前仅少数系统有 config（interaction.range、nest 的 radiusTiles/maxAttempts），configSchema 补写量小。
- `framework/components/registerBuiltin.ts:70-130+` 为内置组件补 configSchema（量大，独立排期，见 §3 里程碑）。

### Phase A5：src/register.ts 接通（src 自定义的硬前提）

现状：`src/register.ts` 只调用了 `bootstrapFramework()`，且**未被任何入口 import**（`src/main.ts` 直接 bootstrap），自定义扩展注册是悬空的。

改动：
1. `src/main.ts` 在 `bootstrapFramework()` 前 import 并执行 `src/register.ts`。
2. sidecar（excalibur_test driver）加载链同步覆盖该入口，使自定义扩展进入注册表、被 `listRegistries` 列出——对接方式由平台侧实施时确认（driver 现仅 require `framework/index.ts`）。
3. 新写扩展时按 A3 规范带上 description / configSchema。

---

## 2. 平台侧改动（excalibur_test，对接契约参考）

1. **sidecar driver**：启动时 AST 解析本体 schema 源码 JSDoc → 双侧递归对齐（按属性名；属性初始化为标识符时解析子 schema const 继续）→ `z.registry()` 构建缓存；新增 `getSchema` RPC 返回 inline JSON Schema（`reused:"inline"`，无 $ref）；`listRegistries` 扩展为每条目返回 `{ id, description, configSchema }`。
   - 依赖：excalibur_test 已加 `ts-morph ^28`（spike 引入）。
   - 源码锚定：以本体仓 .ts 源码路径为准（与 `GAME_ROOT` 同一套解析），本体改打包方式时需联动。
2. **server 路由**：`GET /api/games/:gameId/schemas`（带缓存）。
3. **前端**：ConfigView 双模式（表单默认 + Monaco 兜底）；store draft 改结构化对象、规范化序列化避免无意义 diff；自研 schema 驱动渲染器 + 定制 widget（引用下拉吃 `/registries`、crafting 配方表格、地图 union 选择器）；systems 面板（勾选添加/停用 + config 子表单 + 「需配 rules/<名>.json」提示——系统与规则文件仅命名约定，无强绑定）；引用下拉缺口（item kind / 对话 treeId / 任务 id / 地图 key 来自配置文件本身）由平台在 workspace 上建索引。

---

## 3. 里程碑

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| M1 | A1 注释规范 + A2 五个 SCHEMA_TABLE kind 注释补全 | 无 |
| M2 | A3 register 元数据签名 + A4 内置系统补齐 + A5 register.ts 接通 | M1 |
| M3 | 平台 sidecar getSchema/listRegistries 扩展 + 前端 game.json/rules 表单化 | M1（A3/A4 可并行补） |
| M4 | components configSchema（内置组件批量补齐）+ entities 表单化 | A3, M3 |
| M5 | systems 面板（框架添加/src 自定义管理）+ 引用下拉全量 | M2, M3 |

---

## 4. 已知风险与未决项

1. **组合 bullet / 文档块错位**：spike 用同文件兜底启发式救回，生产化前以 A1 规范消除；对齐器保留告警输出。
2. **`toJSONSchema` 的 `reused:"ref"` 模式未端到端实测**；当前约定 inline 展开（无 $ref），对表单渲染更简单，如未来 schema 规模导致输出过大再评估 ref 模式。
3. **`satisfies z.ZodType<T>` 类一致性校验**（zod↔interface 双源防漂移）暂不引入：本项目无独立 interface 层，zod 即唯一事实源。
4. 平台侧 howto：对齐算法、坑清单、跑法详见 `excalibur_test/docs/spike-jsdoc-schema-report.md` 与 `excalibur_test/scripts/spike-jsdoc-schema.mts`。
