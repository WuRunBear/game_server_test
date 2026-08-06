import { MapSchema, Schema, StateView, type, view, $filter } from "@colyseus/schema";

import { EntityState } from "./EntityState";

/**
 * 兴趣管理下的 per-client 可见实体表（MapSchema 子类，仅增加服务端过滤逻辑）。
 *
 * Colyseus 的 RoomState 对房间内所有客户端共享广播；要让「每个客户端只见自己
 * 视野内实体」，需在编码层做 per-client 过滤——本字段声明了 `view: true`（过滤
 * 字段），配合 `$filter`（schema 实例级过滤）实现：
 * - 共享编码通路（view === undefined）：字段不进共享缓存（返回 false），
 *   该字段只走 per-client 编码。
 * - per-client 编码通路（view 已挂 sessionId）：按「所属玩家 sessionId == 客户端
 *   view 上的 sessionId」判定——每个客户端只能收到自己 PlayerState.visibleEntities。
 *
 * 注意：`view: true` 声明的字段树必须经 `StateView.add()` 加入各客户端 view，
 * 否则该树对任何客户端都不可见（见 GameRoom.onJoin 的接线）。
 *
 * 客户端侧协议无感：schema-codegen 仍按 `MapSchema<EntityState>` 生成；
 * 服务端运行时用子类实例提供过滤。
 */
export class VisibleEntities extends MapSchema<EntityState> {
  /** 服务端元数据：所属玩家 sessionId（自定义属性，不参与网络编码）。 */
  ownerSessionId = "";

  /** 仅对所属玩家可见；其余客户端该字段编码为空。 */
  static [$filter](ref: VisibleEntities, _index: number, view: StateView | undefined): boolean {
    if (view === undefined) return false;
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
   *
   * `@view()` 声明该字段为过滤字段：只在 per-client 编码中出现
   * （$filter 判定所属玩家），不进共享缓存。
   */
  @view()
  @type({ map: EntityState })
  visibleEntities: VisibleEntities = new VisibleEntities();
}
