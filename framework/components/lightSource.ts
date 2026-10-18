import { defineComponent, Types } from "bitecs/legacy";

/**
 * LightSource 组件：实体光源（SoA 结构）。
 *
 * - radius：光照半径（像素），供 BT 条件（IsInLight）等按距离查询
 * - fuelRemainingMs：剩余燃料（毫秒），≤ 0 视为熄灭（不发光）
 * - fuelInfinite：燃料无限标记命中时燃料不消耗、恒视为点亮（与
 *   fuelRemainingMs 并存：显式语义替代「填极大值」的魔法值；随 SoA 入档）
 */
export const LightSource = defineComponent({
  /** 光照半径（像素）。 */
  radius: Types.f32,
  /** 剩余燃料（毫秒）；≤ 0 视为熄灭。 */
  fuelRemainingMs: Types.f32,
  /** 燃料无限（1 = 不消耗、恒点亮；0 = 按 fuelRemainingMs 常规消耗）。 */
  fuelInfinite: Types.ui8,
});
