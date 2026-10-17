// 
// 手动同步副本 — 与 framework/net/colyseus/state/* 保持一致的生成文件
// （仓库无 codegen，手工维护；服务端 schema 变更时须同步本文件）
// 
// 生成工具输出格式：@colyseus/schema 4.0.25
// 
// 协议变更记录（仅动态 key 空间扩展，无字段索引变化）：
// - EntityState.values 新增 key 命名空间 `Progression.totalXp` / `Progression.level` /
//   `Progression.skill.<skillId>.xp|level`（game.json netSync.fields 的 Progression 条目）
// - EntityState.values 新增 key 命名空间 `Achievements.<achievementId>`（值恒 1）
// 两类 key 都进既有 MapSchema<number>，PlayerState/RoomState 字段顺序不变 →
// 旧客户端结构上仍可解码，只是不认识新增 key（需客户端补渲染以展示成长/成就）。
// 

import { Schema, type, ArraySchema, MapSchema, SetSchema, DataChange } from '@colyseus/schema';

export class EntityState extends Schema {
    @type("uint32") public id!: number;
    // 动态数值字段：Component.field（含 Progression.* / Achievements.* 展平 key）
    @type({ map: "number" }) public values: MapSchema<number> = new MapSchema<number>();
    @type({ map: "string" }) public stringValues: MapSchema<string> = new MapSchema<string>();
}

export class PlayerState extends Schema {
    @type("string") public sessionId!: string;
    @type("uint32") public entityId!: number;
    @type("string") public mapId!: string;
    @type({ map: EntityState }) public visibleEntities: MapSchema<EntityState> = new MapSchema<EntityState>();
}

export class RoomState extends Schema {
    @type("uint32") public tick!: number;
    @type("float64") public hour!: number;
    @type("uint8") public phase!: number;
    @type({ map: PlayerState }) public players: MapSchema<PlayerState> = new MapSchema<PlayerState>();
}
