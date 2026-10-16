import { defineComponent, Types } from "bitecs/legacy";

/**
 * Structure 组件：建造结构角色标记（SoA 结构）。
 *
 * v2 地图切片 6：建造实体（楼板/墙/层间连接器）的通用机制词组件——声明
 * 实体在建造层的角色，供三条消费链读取：
 * - entityLevelSystem：挂 Structure（role ≠ 0）的实体**跳过地形层号推导**——
 *   建造物层号在放置/生成时显式写入（楼板悬空于地形层之上，地形推导必错）；
 * - 楼板（floor）：自身层号所在格提供可站面（walkableAtLevel 的建造侧），
 *   其下一格成为「有顶」（房间检测的屋顶语义）；
 * - 墙（wall）：同层挡通行（Collider 承担）与挡视线/围合（房间检测、stranded
 *   洪泛的阻挡集）；
 * - 连接器（connector）：声明连接哪两层与方向（跨层移动的实体侧连接器，
 *   entityLevelSystem 的转移判定纳入）。
 *
 * 角色与连接器方向用整数常量表达（SoA 数值数组）；语义命名映射在配置侧，
 * 框架只认数字（与 Collider.shape 同款约定）。
 */

/** 角色常量：无结构角色（占位值，不参与建造消费链）。 */
export const STRUCTURE_ROLE_NONE = 0;
/** 角色常量：楼板——自身层提供可站面，其下一格有顶。 */
export const STRUCTURE_ROLE_FLOOR = 1;
/** 角色常量：墙——同层挡通行与视线（房间围合边）。 */
export const STRUCTURE_ROLE_WALL = 2;
/** 角色常量：层间连接器——声明连接的两层与方向。 */
export const STRUCTURE_ROLE_CONNECTOR = 3;

/** 连接器方向常量：上行——站在连接器格上从 low 层升至 high 层（low→high）。 */
export const CONNECTOR_DIR_UP = 0;
/** 连接器方向常量：下行——站在连接器格上从 high 层降至 low 层（high→low）。 */
export const CONNECTOR_DIR_DOWN = 1;

export const Structure = defineComponent({
  /** 建造角色（STRUCTURE_ROLE_* 常量）。 */
  role: Types.ui8,
  /** 连接器连接的低层号（role=connector 时有效）。 */
  connectLow: Types.i8,
  /** 连接器连接的高层号（role=connector 时有效）。 */
  connectHigh: Types.i8,
  /** 连接器方向（CONNECTOR_DIR_* 常量）。 */
  connectDir: Types.ui8,
});
