import { gameConfig, serverConfig } from "./config";
import { createPlayer } from "./entityFactory";
import { createGameLoop } from "./gameLoop";
import { startNetworkServer } from "./network/server";
import { createSystems } from "./systems";
import { createLogger } from "./utils/logger";
import { createGameWorld } from "./world";

/**
 * 服务端入口：初始化 World、系统、网络，并启动主循环。
 */
export function main(): void {
  const logger = createLogger("main");

  const world = createGameWorld(Math.floor(1000 / gameConfig.tickRate));
  const systems = createSystems();
  const loop = createGameLoop(world, systems, { tickRate: gameConfig.tickRate });

  const net = startNetworkServer({
    port: serverConfig.port,
    wsPath: serverConfig.wsPath,
    logger: createLogger("net"),
  });

  world.net = net.runtime;

  createPlayer(world, { x: 0, y: 0 });

  loop.start();
  logger.info("游戏循环已启动", { tickRate: gameConfig.tickRate });
}
