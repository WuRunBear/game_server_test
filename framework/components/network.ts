import { defineComponent, Types } from "bitecs/legacy";

/**
 * NetworkId 组件：实体在网络同步中的稳定标识（SoA 结构）。
 *
 * 约定：
 * - value 通常用于服务端/客户端之间的实体映射（不等同于本地 eid）
 */
export const NetworkId = defineComponent({
  /**
   * 网络稳定标识（通常用于与另一端进行实体映射）。
   */
  value: Types.ui32,
});
