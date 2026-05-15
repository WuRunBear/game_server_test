import type { EntityId } from "src/world";

export type BlackboardKey = string;

export interface Blackboard {
  owner: EntityId;
  data: Map<BlackboardKey, unknown>;
}

/**
 * 创建一个新的黑板实例。
 *
 * @param owner 黑板所属实体
 * @returns 初始化后的黑板
 */
export function createBlackboard(owner: EntityId): Blackboard {
  return {
    owner,
    data: new Map(),
  };
}

/**
 * 写入黑板键值。
 *
 * @param bb 黑板
 * @param key 键
 * @param value 值
 */
export function bbSet<T>(bb: Blackboard, key: BlackboardKey, value: T): void {
  bb.data.set(key, value);
}

/**
 * 读取黑板键值。
 *
 * @param bb 黑板
 * @param key 键
 * @returns 对应值；不存在时返回 undefined
 */
export function bbGet<T>(bb: Blackboard, key: BlackboardKey): T | undefined {
  return bb.data.get(key) as T | undefined;
}
