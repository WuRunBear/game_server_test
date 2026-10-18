import { defineComponent, Types } from "bitecs/legacy";

/**
 * Cooldown 组件：冷却计时（SoA 结构）。
 *
 * 约定：
 * - remainingMs：剩余冷却时间（毫秒）
 */
export const Cooldown = defineComponent({
  /**
   * 剩余冷却时间（毫秒）。
   */
  remainingMs: Types.f32,
});
