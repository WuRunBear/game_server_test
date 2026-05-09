import type { ClientToServerMessage, ServerToClientMessage } from "./protocol";

/**
 * 序列化工具（JSON）。
 */
export function encodeServerMessage(message: ServerToClientMessage): string {
  return JSON.stringify(message);
}

/**
 * 反序列化客户端消息，并做最小的字段校验。
 */
export function decodeClientMessage(text: string): ClientToServerMessage | null {
  try {
    const obj = JSON.parse(text) as unknown;
    if (!obj || typeof obj !== "object") return null;
    if ((obj as { t?: unknown }).t !== "input") return null;

    const input = obj as {
      t: "input";
      seq: unknown;
      moveX: unknown;
      moveY: unknown;
    };

    if (typeof input.seq !== "number") return null;
    if (typeof input.moveX !== "number") return null;
    if (typeof input.moveY !== "number") return null;

    return {
      t: "input",
      seq: input.seq,
      moveX: input.moveX,
      moveY: input.moveY,
    };
  } catch {
    return null;
  }
}
