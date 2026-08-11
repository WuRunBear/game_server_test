/**
 * 实体网络状态视图（Colyseus Schema 定义）。
 *
 * 本文件只声明"实体如何同步到客户端"，不含任何仿真逻辑：
 * 每帧由 GameRoom 从仿真快照（TickSnapshot）派生写入本 Schema，
 * Colyseus 自动 diff 后增量推送给客户端（服务端权威，客户端只读）。
 * 具体同步哪些字段由 game.json 的 netSync.fields 配置决定。
 */
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
   *
   * 与 ECS 内部实体 id（eid）不同：eid 由 bitecs 分配、实体销毁后
   * 可能被复用；NetworkId 与实体生命周期绑定、只增不复用，客户端
   * 用它跨帧稳定绑定渲染对象。
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

  /**
   * 字符串字段映射——AoS 适配器展平出的字符串字段（如 "Inventory.0.kind"）。
   * 与数值 values 分开存放，因 Colyseus MapSchema 类型单一。
   */
  @type({ map: "string" })
  stringValues = new MapSchema<string>();
}
