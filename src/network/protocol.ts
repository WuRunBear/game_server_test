import type { EntityId, Tick } from "../world";

/**
 * 网络协议（最小示例，使用 JSON 文本）。
 *
 * 约定：
 * - t 为消息类型
 * - 所有数值字段均为 number（序列化时由 JSON 处理）
 */
export type ClientToServerMessage = ClientToServerInput;

export interface ClientToServerInput {
  t: "input";
  seq: number;
  moveX: number;
  moveY: number;
}

export type ServerToClientMessage = ServerToClientSnapshot;

export interface ServerToClientSnapshot {
  t: "snapshot";
  tick: Tick;
  entities: SnapshotEntity[];
}

export interface SnapshotEntity {
  id: EntityId;
  x: number;
  y: number;
  hp: number;
}
