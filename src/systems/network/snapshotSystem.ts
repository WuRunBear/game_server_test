import { query } from "bitecs";

import { Health, NetworkId, Transform } from "../../components";
import type { ServerToClientSnapshot } from "../../network/protocol";
import type { GameWorld } from "../../world";

/**
 * 快照系统：把需要同步的数据收集成一帧快照，交给广播系统发送。
 */
export function snapshotSystem(world: GameWorld): GameWorld {
  if (!world.net) return world;

  const entities: ServerToClientSnapshot["entities"] = [];

  for (const eid of query(world, [NetworkId, Transform, Health])) {
    entities.push({
      id: NetworkId.value[eid],
      x: Transform.x[eid],
      y: Transform.y[eid],
      hp: Health.current[eid],
    });
  }

  world.net.pendingSnapshot = {
    t: "snapshot",
    tick: world.time.tick,
    entities,
  };

  return world;
}
