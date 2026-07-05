import { MapSchema, Schema, type } from "@colyseus/schema";

/**
 * 可同步到客户端的实体状态（用于 Colyseus Room State 增量同步）。
 *
 * 字段采用动态映射：所有业务字段通过 `values` MapSchema 按 key 存取值，
 * key 约定为 `"ComponentName.fieldName"`（如 `"Transform.x"`、`"Health.current"`）。
 * 具体同步哪些字段由 `game.json` 的 `netSync.fields` 配置决定。
 */
export class EntityState extends Schema {
  /**
   * 实体的稳定网络标识（来自 NetworkId.value）。
   */
  @type("uint32")
  id: number = 0;

  /**
   * 动态字段映射，key 格式为 `"ComponentName.fieldName"`。
   *
   * 示例：
   * - `"Transform.x"` / `"Transform.y"` → 世界坐标
   * - `"Health.current"` → 当前血量
   * - `"Collider.shape"` / `"Collider.radius"` → 碰撞体参数
   * - 任意自定义组件字段均可通过 netSync 配置加入同步
   */
  @type({ map: "number" })
  values = new MapSchema<number>();
}
