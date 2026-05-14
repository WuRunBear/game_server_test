import { gameConfig, serverConfig } from "config";
import { createPlayer } from "factories";
import { createGameLoop } from "src/gameLoop";
import { startNetworkServer } from "network/server";
import { createSystems } from "systems";
import { createLogger } from "utils/logger";
import { createGameWorld } from "src/world";

/**
 * 服务端入口：初始化 World、系统、网络，并启动主循环。
 */
export function main(): void {
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
}
