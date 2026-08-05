import { MapSchema, Schema, StateView, type, $filter } from "@colyseus/schema";

import { EntityState } from "./EntityState";

/**
 * 兴趣管理下的 per-client 可见实体表（MapSchema 子类，仅增加服务端过滤逻辑）。
 *
 * Colyseus 的 RoomState 对房间内所有客户端共享广播；要让「每个客户端只见自己
 * 视野内实体」，需在编码层做 per-client 过滤——`$filter`（schema 实例级过滤）：
 * 编码时对每个字段调用 `ctor[$filter](ref, index, view)`，返回 false 则该字段
 * 对该客户端不可见（编码为空）。这里按「所属玩家 sessionId == 客户端 view 上的
 * sessionId」判定，实现：每个客户端只能收到自己 PlayerState.visibleEntities 的内容。
 *
 * 客户端侧协议无感：schema-codegen 仍按 `MapSchema<EntityState>` 生成；
 * 服务端运行时用子类实例提供过滤。
 */
export class VisibleEntities extends MapSchema<EntityState> {
  /** 服务端元数据：所属玩家 sessionId（自定义属性，不参与网络编码）。 */
  ownerSessionId = "";

  /** 仅对所属玩家可见；其余客户端该字段编码为空。 */
  static [$filter](ref: VisibleEntities, _index: number, view: StateView): boolean {
    return (view as unknown as { sessionId?: string }).sessionId === ref.ownerSessionId;
  }
}

/**
 * 可同步到客户端的玩家状态（与连接 sessionId 绑定）。
 *
 * 说明：
 * - sessionId 由 Colyseus 分配，用于标识连接
 * - entityId 用于客户端把“玩家”映射到 entities 中的实体状态
 * - visibleEntities 是兴趣管理（视野裁剪）下的 per-client 实体表：
 *   key=NetworkId，只含该玩家视野内的实体，且经 $filter 仅对所属玩家可见。
 *   未启用视野裁剪时为空，实体数据走 RoomState.entities 全量广播。
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
  visibleEntities: VisibleEntities = new VisibleEntities();
}
