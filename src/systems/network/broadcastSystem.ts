import type { GameWorld } from "../../world";

export function broadcastSystem(world: GameWorld): GameWorld {
  if (!world.net) return world;
  if (!world.net.pendingSnapshot) return world;

  world.net.broadcast(world.net.pendingSnapshot);
  world.net.pendingSnapshot = null;

  return world;
}
