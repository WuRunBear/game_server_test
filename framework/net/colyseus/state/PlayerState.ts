import { Schema, type } from "@colyseus/schema";

/**
 * 可同步到客户端的玩家状态（与连接 sessionId 绑定）。
 *
 * 说明：
 * - sessionId 由 Colyseus 分配，用于标识连接
 * - entityId 用于客户端把“玩家”映射到 entities 中的实体状态
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
}
