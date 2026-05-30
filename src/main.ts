import { startColyseusServer } from "network/colyseus/server";
import { createLogger } from "utils/logger";

/**
 * 服务端入口：启动 Colyseus 服务器。
 */
export function main(): void {
  startColyseusServer({ logger: createLogger("net") });
}
