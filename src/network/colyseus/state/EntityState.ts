import { Schema, type } from "@colyseus/schema";

/**
 * 可同步到客户端的实体状态（用于 Colyseus Room State 增量同步）。
 *
 * 说明：
 * - 该结构只包含“客户端渲染/表现需要的数据”，不承载服务端的完整 ECS 组件
 * - 字段类型与编号由 @colyseus/schema 决定，客户端会自动收到增量更新
 */
export class EntityState extends Schema {
  /**
   * 实体的稳定网络标识（来自 NetworkId.value）。
   */
  @type("uint32")
  id: number = 0;

  /**
   * 世界坐标 x。
   */
  @type("number")
  x: number = 0;

  /**
   * 世界坐标 y。
   */
  @type("number")
  y: number = 0;

  /**
   * 当前血量（最小示例字段）。
   */
  @type("int32")
  hp: number = 0;
}
