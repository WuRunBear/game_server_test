/**
 * EntityLevel 组件：实体所在离散层号（AoS 结构）。
 *
 * 每个实体记录其所在层号（0 = 地面基准层，负层为地下预留）；无条目时由
 * entityLevelOf 回退 0。层是纯序数、没有物理高度——服务端对 level 只做
 * 比大小/判相邻，跨层移动与按层碰撞由后续切片接线（本切片仅交付载体，
 * 无消费方、无写入方）。
 *
 * 参照 EntityMap 模式：运行时写入、不由 archetype 声明（无 initializer——
 * 运行时层号依赖几何/连接器查询，静态原型配置表达不了）；未列入
 * worldSerializer 的瞬态跳过清单，随实体自然入档/恢复；**不注册 netSync
 * AoS 适配器**——本切片无网络消费方（未注册适配器的 AoS 组件在同步快照
 * 中被静默跳过，服务端权威即可），跨层状态上线时（跨层移动切片）再接线。
 */

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const EntityLevel = [] as (number | undefined)[];

/**
 * 取实体所在层号；实体无条目时回退地面基准层 0。
 */
export function entityLevelOf(eid: number): number {
  return EntityLevel[eid] ?? 0;
}
