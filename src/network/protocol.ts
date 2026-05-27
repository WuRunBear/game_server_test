import type { ClientMessage, Input, ServerMessage, Snapshot, SnapshotEntity } from "network/gen/game/v1/network_pb";

export { ClientMessageSchema, InputSchema, ServerMessageSchema, SnapshotEntitySchema, SnapshotSchema } from "network/gen/game/v1/network_pb";
export type { ClientMessage, Input, ServerMessage, Snapshot, SnapshotEntity } from "network/gen/game/v1/network_pb";

/**
 * 为了减少业务代码改动，保留原有命名的类型别名。
 */
export type ClientToServerInput = Input;
export type ClientToServerMessage = ClientMessage;
export type ServerToClientSnapshot = Snapshot;
export type ServerToClientMessage = ServerMessage;
