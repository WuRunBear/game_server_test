import { defineComponent, Types } from "bitecs/legacy";

/**
 * Transform 组件：二维位置/朝向/缩放（SoA 结构）。
 *
 * - x/y：世界坐标位置（单位与地图/逻辑一致）
 * - rot：旋转角度（单位以系统实现为准）
 * - scale：缩放比例（1 表示原始大小）
 */
export const Transform = defineComponent({
  /**
   * 世界坐标 x。
   */
  x: Types.f32,
  /**
   * 世界坐标 y。
   */
  y: Types.f32,
  /**
   * 旋转角度（单位以系统实现为准）。
   */
  rot: Types.f32,
  /**
   * 缩放比例（1 表示原始大小）。
   */
  scale: Types.f32,
});
