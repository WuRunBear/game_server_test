import { defineComponent, Types } from "bitecs/legacy";

/**
 * Perception 组件：实体感知能力（SoA 结构）。
 *
 * 字段语义由 perceptionSystem 消费：
 * - visionRadius：感知半径（像素），视野内的敌对实体写入黑板供 BT 决策
 * - hostilityRange：敌对反应半径（像素），供后续切片（受击反击等）使用，
 *   当前无消费方，字段先占位
 */
export const Perception = defineComponent({
  /**
   * 感知半径（像素）。
   */
  visionRadius: Types.f32,
  /**
   * 敌对反应半径（像素）。
   */
  hostilityRange: Types.f32,
});
