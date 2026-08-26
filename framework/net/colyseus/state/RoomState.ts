/**
 * 单房间可同步状态视图（Colyseus Schema 定义）。
 *
 * RoomState 不是 ECS 世界本身，只是每 tick 从仿真快照派生的只读视图：
 * GameRoom 每帧把 TickSnapshot 映射到本 Schema，Colyseus 自动 diff 后
 * 增量推送给房间内客户端（服务端权威，客户端不做逻辑）。
 * players 以 sessionId 为 key，与 ECS 内部 eid 无关。
 * 地图/实体数据已按玩家拆分：地图 id 在 PlayerState.mapId（per-player maps），
 * 实体同步恒走 per-client 可见表（PlayerState.visibleEntities）。
 */
import { MapSchema, Schema, type } from "@colyseus/schema";

import { PlayerState } from "./PlayerState";

/**
 * 单房间的可同步状态（客户端通过 Colyseus 自动接收增量更新）。
 *
 * 约定：
 * - tick 为逻辑帧号（与 ECS world.time.tick 对齐）
 * - players 用 sessionId 做 key，便于客户端识别“自己是谁”
 * - 地图 id 与实体同步均为 per-player：PlayerState.mapId / visibleEntities
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
   * 房间内玩家列表（key=sessionId）。
   */
  @type({ map: PlayerState })
  players: MapSchema<PlayerState> = new MapSchema<PlayerState>();
}
