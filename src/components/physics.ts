import { defineComponent, Types } from "bitecs/legacy";

/**
 * Velocity 组件：实体速度（SoA 结构）。
 *
 * 约定：
 * - vx/vy 表示每个 tick 的位移增量（与 Transform.x/y 同一单位）
 */
export const Velocity = defineComponent({
  /**
   * x 方向速度。
   */
  vx: Types.f32,
  /**
   * y 方向速度。
   */
  vy: Types.f32,
});

/**
 * Acceleration 组件：实体加速度（SoA 结构）。
 *
 * 约定：
 * - ax/ay 表示每个 tick 的速度增量（与 Velocity.vx/vy 同一单位）
 */
export const Acceleration = defineComponent({
  /**
   * x 方向加速度。
   */
  ax: Types.f32,
  /**
   * y 方向加速度。
   */
  ay: Types.f32,
});

/**
 * Collider 形状类型。
 *
 * 约定：
 * - 数值存储在 Collider.shape 中，便于组件保持 SoA 结构
 */
export const ColliderShape = {
  /**
   * 圆形碰撞体。
   */
  Circle: 0,
  /**
   * 矩形碰撞体（AABB）。
   */
  Box: 1,
} as const;

/**
 * Collider 组件：实体碰撞体参数（SoA 结构）。
 *
 * 约定：
 * - shape：形状类型，取值见 ColliderShape
 * - Circle：使用 radius
 * - Box：使用 halfW/halfH
 */
export const Collider = defineComponent({
  /**
   * 碰撞体形状类型，取值见 ColliderShape。
   */
  shape: Types.ui8,
  /**
   * 圆形半径（仅 shape=Circle 时有效）。
   */
  radius: Types.f32,
  /**
   * 矩形半宽（仅 shape=Box 时有效）。
   */
  halfW: Types.f32,
  /**
   * 矩形半高（仅 shape=Box 时有效）。
   */
  halfH: Types.f32,
});
