//
// 客户端 schema 副本 — 由 @colyseus/schema 的 schema-codegen 生成，
// 与服务端 framework/net/colyseus/state/*.ts 逐字段一致（字段名/顺序/类型）。
//
// 生成：pnpm schema:gen（tools/schemaCheck.ts --write）
//   内部调用 schema-codegen 生成临时产物后写回本文件（保留本注释头）：
//   schema-codegen framework/net/colyseus/state/RoomState.ts \
//       --output <tmp> --ts --bundle
//   也可手工执行上述命令到临时目录后对照（codegen 从 RoomState.ts 跟随
//   import，自动打包 EntityState/PlayerState）。
// 校验：pnpm schema:check（tools/schemaCheck.ts：重新生成 → 去注释后逐行比较；
//   framework/__tests__/client-schema-consistency.test.ts 复用同一实现）
//
// ⚠ 协议变更，需升级客户端 schema（schema 字段索引即线上格式，旧客户端
//   解码新流会错位）：
// - EntityState.level（int8，字段末尾新增）：实体离散层号（EntityLevel，
//   缺省 0）；既有 id/values/stringValues 字段索引不变。
// - RoomState 末尾新增四字段（既有 tick/hour/phase/players 索引不变）：
//   weatherId（string，当前天气 id）、phaseId（string，当前相位 id）、
//   phaseProgress（number，当前相位进度 0..1）、offers（{map:"string"}，
//   报价摘要：offerId → JSON 字符串 `{"from","to","give","take"}`；
//   from/to 为 networkId，视角以发起方为基准；只有参与方可见该条目）。
// - CC-14 Network Feel（各自末尾追加，旧索引不变）：
//   RoomState.serverTimeMs（float64，逻辑服务器时间 = tick × fixedDtMs，非墙钟）、
//   PlayerState.lastProcessedSeq（uint32，该会话已接受的最大输入 seq；被拒输入不推进）。
// - CC-12 Weather / Season View（RoomState 末尾追加，旧索引不变）：
//   dayIndex（uint32，daynight 24 小时日计数：tick 0/hour 8 = 第 0 天，跨午夜 +1；
//   不是相位程序的 phaseAt().dayIndex）、seasonId（string，environment.seasons
//   循环；未配置空串）、weatherIntensity（float64，被选中天气的 intensity [0,1]；
//   未配置 0）。温度不建模：配置只有 temperatureOffset 修饰值，无基准温度。
// - 动态 key 空间扩展（不改变 schema 字段索引，旧客户端结构上可解码，
//   但需补渲染才可见）：
//   EntityState.values：`Structure.role|connectLow|connectHigh|connectDir`
//     （建造角色/连接器，整数）、`Passage.open`（可开合屏障状态，0/1）、
//     `Inventory.<i>.durability`（仅带耐久的
//     槽位写键）、`ItemMeta.durability`、`Crafting.<i>.remainingTicks` /
//     `.progress` / `.suspended`（进行中制作）、`Progression.*`、`Achievements.*`、
//     `Cooldown.remainingMs`（玩家冷却剩余毫秒）；
//   EntityState.stringValues：`Inventory.<i>.kind`、`ItemMeta.kind`、
//     `Crafting.<i>.recipeId`、`Dialogue.text`（对话正文）、
//     `Dialogue.option.<i>.text`（选项文案）等既有/新增字符串 key。
//
// GENERATED USING @colyseus/schema 4.0.25
//

import { Schema, type, ArraySchema, MapSchema, SetSchema, DataChange } from '@colyseus/schema';

export class EntityState extends Schema {
    @type("uint32") public id!: number;
    @type({ map: "number" }) public values: MapSchema<number> = new MapSchema<number>();
    @type({ map: "string" }) public stringValues: MapSchema<string> = new MapSchema<string>();
    @type("int8") public level!: number;
}

export class PlayerState extends Schema {
    @type("string") public sessionId!: string;
    @type("uint32") public entityId!: number;
    @type("string") public mapId!: string;
    @type({ map: EntityState }) public visibleEntities: MapSchema<EntityState> = new MapSchema<EntityState>();
    @type("string") public mapVersion!: string;
    @type("string") public displayName!: string;
    @type("string") public characterId!: string;
    @type("string") public appearance!: string;
    @type("uint32") public lastProcessedSeq!: number;
}

export class RoomState extends Schema {
    @type("uint32") public tick!: number;
    @type("float64") public hour!: number;
    @type("uint8") public phase!: number;
    @type({ map: PlayerState }) public players: MapSchema<PlayerState> = new MapSchema<PlayerState>();
    @type("string") public weatherId!: string;
    @type("string") public phaseId!: string;
    @type("number") public phaseProgress!: number;
    @type({ map: "string" }) public offers: MapSchema<string> = new MapSchema<string>();
    @type("float64") public serverTimeMs!: number;
    @type("uint32") public dayIndex!: number;
    @type("string") public seasonId!: string;
    @type("float64") public weatherIntensity!: number;
}
