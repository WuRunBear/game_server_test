/**
 * EntityLevel 组件：实体所在离散层号（AoS 结构）。
 *
 * 每个实体记录其所在层号（0 = 地面基准层，负层为地下预留）；无条目时由
 * entityLevelOf 回退 0。层是纯序数、没有物理高度——服务端对 level 只做
 * 比大小/判相邻。v2 地图切片 5 起接入消费方与写入方：entityLevelSystem
 * 按「位置 × 地图数据」推导并写回（首次确立 + 过渡校验），碰撞运行时按
 * (mapId, level) 分区路由，投射物生成时随主人锁层，兴趣裁剪按同图同层
 * 收窄（快照 EntitySnapshot.level）。
 *
 * 参照 EntityMap 模式：运行时写入、不由 archetype 声明（无 initializer——
 * 运行时层号依赖几何/连接器查询，静态原型配置表达不了）；未列入
 * worldSerializer 的瞬态跳过清单，随实体自然入档/恢复；**不注册 netSync
 * AoS 适配器**——层号经快照 DTO 的 level 字段参与服务端兴趣裁剪，客户端
 * 协议字段留待客户端渲染切片接线。
 */

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const EntityLevel = [] as (number | undefined)[];

/**
 * 取实体所在层号；实体无条目时回退地面基准层 0。
 */
export function entityLevelOf(eid: number): number {
  return EntityLevel[eid] ?? 0;
}
