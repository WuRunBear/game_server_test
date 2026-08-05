import { MapSchema, Schema, type } from "@colyseus/schema";

import { EntityState } from "./EntityState";

/**
 * 可同步到客户端的玩家状态（与连接 sessionId 绑定）。
 *
 * 说明：
 * - sessionId 由 Colyseus 分配，用于标识连接
 * - entityId 用于客户端把“玩家”映射到 entities 中的实体状态
 * - visibleEntities 是兴趣管理（视野裁剪）下的 per-client 实体表：
 *   key=NetworkId，只含该玩家视野内的实体。未启用视野裁剪时为空，
 *   实体数据走 RoomState.entities 全量广播。
 */
export class PlayerState extends Schema {
  /**
   * 当前玩家连接的 sessionId。
   */
  @type("string")
  sessionId: string = "";

  /**
   * 该玩家对应的实体网络标识（来自 NetworkId.value）。
   */
  @type("uint32")
  entityId: number = 0;

  /**
   * 该玩家视野内可见的实体状态表（key=NetworkId 字符串）。
   */
  @type({ map: EntityState })
  visibleEntities = new MapSchema<EntityState>();
}
