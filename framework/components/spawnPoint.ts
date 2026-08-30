/**
 * SpawnPoint 组件：实体持久化出生点（AoS 结构）。
 *
 * 记录实体创建时的出生落点（地图 id + 像素坐标）。重生（respawnSystem）
 * 读取本组件回到出生点——Transform 会被移动覆盖，不能承载出生点语义；
 * 组件未列入 worldSerializer 的瞬态跳过清单，随实体自然入档/恢复。
 *
 * 由玩家创建链路（GameSimulation.addPlayer）按出生规则选点后直接写入，
 * 不由 archetype 声明（无 initializer——出生点依赖运行时几何查询，无法由
 * 静态原型配置表达，与 EntityMap 同理）。
 */

/** 出生点状态：出生地图（world.maps 的 registry key）+ 像素坐标。 */
export interface SpawnPointState {
  /** 出生地图 id（registry key）。 */
  mapId: string;
  /** 出生 X（世界坐标，像素）。 */
  x: number;
  /** 出生 Y（世界坐标，像素）。 */
  y: number;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const SpawnPoint = [] as (SpawnPointState | undefined)[];
