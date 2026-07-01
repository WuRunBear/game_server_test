import type { EntityId } from "framework/world";

export type BlackboardKey = string;

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
