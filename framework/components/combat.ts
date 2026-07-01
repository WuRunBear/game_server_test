import { defineComponent, Types } from "bitecs/legacy";

/**
 * Health 组件：实体生命值（SoA 结构）。
 *
 * - current：当前生命值
 * - max：最大生命值
 */
export const Health = defineComponent({
  /**
   * 当前生命值。
   */
  current: Types.f32,
  /**
   * 最大生命值。
   */
  max: Types.f32,
});

/**
 * Attack 组件：实体攻击力（SoA 结构）。
 */
export const Attack = defineComponent({
  /**
   * 攻击力数值。
   */
  value: Types.f32,
});

/**
 * Defense 组件：实体防御力（SoA 结构）。
 */
export const Defense = defineComponent({
  /**
   * 防御力数值。
   */
  value: Types.f32,
});

/**
 * Team 组件：实体阵营/队伍标识（SoA 结构）。
 *
 * 约定：
 * - id 用于友伤判定、仇恨归属等逻辑的分组依据
 */
export const Team = defineComponent({
  /**
   * 阵营/队伍标识。
   */
  id: Types.ui32,
});
