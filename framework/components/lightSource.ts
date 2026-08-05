import { defineComponent, Types } from "bitecs/legacy";

/**
 * LightSource 组件：实体光源（SoA 结构）。
 *
 * - radius：光照半径（像素），供 BT 条件（IsInLight）等按距离查询
 * - fuelRemainingMs：剩余燃料（毫秒），≤ 0 视为熄灭（不发光）；
 *   本切片无燃料消耗系统，静态/玩家放置的光源配置常量大值即可
 */
export const LightSource = defineComponent({
  /** 光照半径（像素）。 */
  radius: Types.f32,
  /** 剩余燃料（毫秒）；≤ 0 视为熄灭。 */
  fuelRemainingMs: Types.f32,
});
