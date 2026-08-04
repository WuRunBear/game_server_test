import type { EntityId } from "framework/world";

export type BlackboardKey = string;

/** 感知结果：最近敌对目标（perceptionSystem 写入）。 */
export interface PerceivedTarget {
  eid: EntityId;
  dist: number;
}

/** 黑板 key：最近敌对目标。 */
export const BB_PERCEPTION_TARGET = "perception.target";

export interface Blackboard {
  owner: EntityId;
  data: Map<BlackboardKey, unknown>;
}

export function createBlackboard(owner: EntityId): Blackboard {
  return {
    owner,
    data: new Map(),
  };
}

export function bbSet<T>(bb: Blackboard, key: BlackboardKey, value: T): void {
  bb.data.set(key, value);
}

export function bbGet<T>(bb: Blackboard, key: BlackboardKey): T | undefined {
  return bb.data.get(key) as T | undefined;
}
