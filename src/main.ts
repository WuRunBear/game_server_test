import { bootstrapFramework } from "framework/bootstrap";
import { startColyseusServer } from "network/colyseus/server";
import { createLogger } from "utils/logger";

export function main(): void {
  bootstrapFramework();
  startColyseusServer({
    logger: createLogger("net"),
    gameJsonPath: process.env.GAME_CONFIG_PATH,
  });
}
