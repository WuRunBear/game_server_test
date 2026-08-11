/**
 * 黑板（Blackboard）：行为树节点间共享的运行时数据区。
 *
 * - 每块黑板绑定一个实体（owner），内部是 key → value 的 Map；
 * - 感知系统每 tick 写入感知结果（如最近敌对目标），action/condition 节点用 bbGet 读取；
 * - 与 AIState 组件互补：AIState 是 SoA 数值组件（存状态标识、可序列化），
 *   黑板存结构化的运行期中间数据，不占组件定义、不随实体序列化。
 */
import type { EntityId } from "framework/world";

export type BlackboardKey = string;

/** 感知结果：最近敌对目标（perceptionSystem 写入）。 */
export interface PerceivedTarget {
  eid: EntityId;
  dist: number;
}

/** 黑板 key：最近敌对目标。 */
export const BB_PERCEPTION_TARGET = "perception.target";

/** 黑板数据：owner 为所属实体 eid，data 为键值存储（key → 任意值）。 */
export interface Blackboard {
  owner: EntityId;
  data: Map<BlackboardKey, unknown>;
}

/** 创建一块空黑板（data 初始为空 Map）。 */
export function createBlackboard(owner: EntityId): Blackboard {
  return {
    owner,
    data: new Map(),
  };
}

/** 写入黑板：key → value（覆盖同 key 旧值）。 */
export function bbSet<T>(bb: Blackboard, key: BlackboardKey, value: T): void {
  bb.data.set(key, value);
}

/** 读取黑板：key 不存在时返回 undefined。 */
export function bbGet<T>(bb: Blackboard, key: BlackboardKey): T | undefined {
  return bb.data.get(key) as T | undefined;
}
