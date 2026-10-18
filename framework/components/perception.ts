import { defineComponent, Types } from "bitecs/legacy";

/**
 * Perception 组件：实体感知能力（SoA 结构）。
 *
 * 字段语义由 perceptionSystem 消费：
 * - visionRadius：感知半径（像素），视野内的敌对实体写入黑板供 BT 决策
 */
export const Perception = defineComponent({
  /**
   * 感知半径（像素）。
   */
  visionRadius: Types.f32,
});
