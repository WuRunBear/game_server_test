import { fromBinary, toBinary } from "@bufbuild/protobuf";

import { ClientMessageSchema, ServerMessageSchema, type ClientToServerMessage, type ServerToClientMessage } from "network/protocol";

/**
 * 将服务端消息序列化为 Protobuf 二进制。
 *
 * @param message 服务端消息
 * @returns 可直接通过 WebSocket 发送的二进制数据
 */
export function encodeServerMessage(message: ServerToClientMessage): Uint8Array {
  return toBinary(ServerMessageSchema, message);
}

/**
 * 反序列化客户端消息（Protobuf 二进制）。
 *
 * @param bytes 客户端发送的二进制数据
 * @returns 客户端消息；解析失败返回 null
 */
export function decodeClientMessage(bytes: Uint8Array): ClientToServerMessage | null {
  try {
    return fromBinary(ClientMessageSchema, bytes);
  } catch {
    return null;
  }
}
