// 
// 手动同步副本 — 与 framework/net/colyseus/state/* 保持一致的生成文件
// （仓库无 codegen，手工维护；服务端 schema 变更时须同步本文件）
// 
// 生成工具输出格式：@colyseus/schema 4.0.25
// 

import { Schema, type, ArraySchema, MapSchema, SetSchema, DataChange } from '@colyseus/schema';

export class EntityState extends Schema {
    @type("uint32") public id!: number;
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
