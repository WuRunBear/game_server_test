import { gameConfig, getMapSourceFromConfig, serverConfig } from "config";
import { createNpc, createPlayer } from "factories";
import { buildMapRuntime } from "map";
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

  world.map = buildMapRuntime(getMapSourceFromConfig());

  const playerSpawn = world.map.spawns.player ?? { x: 0, y: 0 };
  createPlayer(world, { x: playerSpawn.x, y: playerSpawn.y });

  for (const spawn of world.map.spawns.npcs) {
    createNpc(world, { x: spawn.pos.x, y: spawn.pos.y, kind: spawn.kind });
  }

  loop.start();
}
