import { defineComponent, Types } from "bitecs/legacy";

/**
 * GridOccupancy 组件：网格占用标记（SoA 结构）。
 *
 * 挂载该组件的实体占据地图网格上的一个矩形格组（cellW×cellH 格）。
 * - 放置物（见 placeableSystem）在放置时按地图 tile 对齐写入格组；
 * - 放置校验用格组冲突判定（同格重放被拒），与 AABB 重叠校验互补
 *   （格组保证对齐后的无缝拼接，AABB 防与生物/资源交叉）。
 * - 无地图时不写入（cell 值保持 0，不参与占用判定）。
 */
export const GridOccupancy = defineComponent({
  /** 占用格组左上角 X（tile 索引）。 */
  cellX: Types.i32,
  /** 占用格组左上角 Y（tile 索引）。 */
  cellY: Types.i32,
  /** 占用的列数（沿 X 方向）。 */
  cellW: Types.i32,
  /** 占用的行数（沿 Y 方向）。 */
  cellH: Types.i32,
});
