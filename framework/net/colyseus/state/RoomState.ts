import { MapSchema, Schema, type } from "@colyseus/schema";

import { EntityState } from "./EntityState";
import { PlayerState } from "./PlayerState";

/**
 * 单房间的可同步状态（客户端通过 Colyseus 自动接收增量更新）。
 *
 * 约定：
 * - tick 为逻辑帧号（与 ECS world.time.tick 对齐）
 * - players 用 sessionId 做 key，便于客户端识别“自己是谁”
 * - entities 用 NetworkId 做 key，便于客户端稳定绑定渲染对象
 */
export class RoomState extends Schema {
  /**
   * 当前逻辑帧号。
   */
  @type("uint32")
  tick: number = 0;

  /**
   * world 级昼夜小时（0-24，来自仿真快照的 timeOfDay.hour）。
   */
  @type("float64")
  hour: number = 8;

  /**
   * world 级昼夜相位（0=白天，1=夜晚，来自仿真快照的 timeOfDay.phase）。
   */
  @type("uint8")
  phase: number = 0;

  /**
   * 当前地图 id（来自仿真快照的 mapId；无地图时为空串）。
   * 客户端据此切换渲染场景。
   */
  @type("string")
  mapId: string = "";

  /**
   * 房间内玩家列表（key=sessionId）。
   */
  @type({ map: PlayerState })
  players: MapSchema<PlayerState> = new MapSchema<PlayerState>();

  /**
   * 房间内实体状态表（key=NetworkId 字符串）。
   */
  @type({ map: EntityState })
  entities: MapSchema<EntityState> = new MapSchema<EntityState>();
}
