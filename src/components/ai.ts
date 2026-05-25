
import { defineComponent, Types } from "bitecs/legacy";

/**
 * AIState 组件：实体的 AI 状态标识（SoA 结构）。
 *
 * 约定：
 * - state 存放状态数值（例如：有限状态机的 stateId）
 */
export const AIState = defineComponent({
  /**
   * AI 状态值（例如：有限状态机的 stateId）。
   */
  state: Types.ui16,
});

/**
 * Target 组件：实体当前锁定的目标实体（SoA 结构）。
 *
 * 约定：
 * - entity 存放目标实体 eid；没有目标时通常为 0（以系统实现为准）
 */
export const Target = defineComponent({
  /**
   * 目标实体 eid。
   */
  entity: Types.ui32,
});

/**
 * BlackboardRef 组件：实体关联的黑板数据引用（SoA 结构）。
 *
 * 约定：
 * - id 存放黑板数据的标识（可用于在其他存储中索引/查找）
 */
export const BlackboardRef = defineComponent({
  /**
   * 黑板数据标识（可用于在其他存储中索引/查找）。
   */
  id: Types.ui32,
});
