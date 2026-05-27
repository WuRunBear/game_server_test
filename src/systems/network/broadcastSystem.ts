import { create } from "@bufbuild/protobuf";

import { ServerMessageSchema } from "network/protocol";
import type { GameWorld } from "src/world";

/**
 * 广播系统：把快照系统生成的 pendingSnapshot 广播给所有客户端。
 *
 * @param world ECS World
 * @returns 处理后的 World
 */
export function broadcastSystem(world: GameWorld): GameWorld {
  if (!world.net) return world;
  if (!world.net.pendingSnapshot) return world;

  world.net.broadcast(
    create(ServerMessageSchema, {
      payload: { case: "snapshot", value: world.net.pendingSnapshot },
    }),
  );
  world.net.pendingSnapshot = null;

  return world;
}
