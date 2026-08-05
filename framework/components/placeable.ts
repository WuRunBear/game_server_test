import { defineComponent, Types } from "bitecs/legacy";

/**
 * Placeable 组件：玩家可放置物标记（SoA 结构）。
 *
 * 挂载该组件的实体可被玩家经 place 命令放置（见 placeableSystem）：
 * - footprintW/footprintH：放置时的占位尺寸（像素），放置校验（重叠/地图阻挡）用
 * - canCollide：放置后是否参与碰撞（1=是，0=否）
 * - ownerNetworkId：放置者 networkId（0=无主，如地图静态布置的放置物）；
 *   deconstruct（拆除）仅放置者可拆
 */
export const Placeable = defineComponent({
  /** 占位宽度（像素）。 */
  footprintW: Types.f32,
  /** 占位高度（像素）。 */
  footprintH: Types.f32,
  /** 放置后是否参与碰撞（1=是，0=否）。 */
  canCollide: Types.ui8,
  /** 放置者网络标识（0=无主/世界物）。 */
  ownerNetworkId: Types.ui32,
});
