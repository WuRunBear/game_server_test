import { defineComponent, Types } from "bitecs/legacy";

/**
 * CraftingStation 组件：合成站点（SoA 结构）。
 *
 * stationType 是跨实体约定的站点类型编号（0 = 通用手搓，无需站点），
 * 具体编号语义由 game/ 配置约定；框架只做数值相等比较，
 * 不识别任何游戏专属的站点名。
 */
export const CraftingStation = defineComponent({
  /** 站点类型编号。 */
  stationType: Types.ui32,
});
