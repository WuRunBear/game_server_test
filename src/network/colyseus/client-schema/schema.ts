// 
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
// 
// GENERATED USING @colyseus/schema 4.0.25
// 

import { Schema, type, MapSchema } from '@colyseus/schema';

export class EntityState extends Schema {
    @type("uint32") public id!: number;
    @type("number") public x!: number;
    @type("number") public y!: number;
    @type("int32") public hp!: number;
}

export class PlayerState extends Schema {
    @type("string") public sessionId!: string;
    @type("uint32") public entityId!: number;
}

export class RoomState extends Schema {
    @type("uint32") public tick!: number;
    @type({ map: PlayerState }) public players: MapSchema<PlayerState> = new MapSchema<PlayerState>();
    @type({ map: EntityState }) public entities: MapSchema<EntityState> = new MapSchema<EntityState>();
}
