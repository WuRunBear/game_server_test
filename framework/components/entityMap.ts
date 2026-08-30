/**
 * EntityMap 组件：实体所属地图标识（AoS 结构）。
 *
 * 每个实体记录其所属地图 id 字符串（如 "main" / "annex"）；无条目时由
 * entityMapOf 回退到 world.defaultMapId。地图是一种通用分区机制：同一张地图的
 * 实体互相可见/交互，不同地图互不干扰（分区语义由各系统按 entityMapOf 过滤，
 * 本组件不包含任何游戏专属地图语义）。
 *
 * 由 spawn 链（spawnEntity / spawnDroppedItem 等）写入，不由 archetype 声明
 * （无 initializer——运行时地图 id 无法由 archetype 配置表达）。
 */
import type { GameWorld } from "framework/world";

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const EntityMap = [] as (string | undefined)[];

/**
 * 取实体所属地图 id；实体无条目时回退世界默认地图（世界未配置默认图时返回 ""）。
 */
export function entityMapOf(world: GameWorld, eid: number): string {
  return EntityMap[eid] ?? world.defaultMapId ?? "";
}
