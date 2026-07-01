import { query } from "bitecs";

import { Transform, Velocity } from "components";
import type { GameWorld } from "world";

/**
 * 移动系统：把速度积分到位置上。
 */
export function movementSystem(world: GameWorld): GameWorld {
  const dtSec = world.time.dtMs / 1000;

  for (const eid of query(world, [Transform, Velocity])) {
    Transform.x[eid] += Velocity.vx[eid] * dtSec;
    Transform.y[eid] += Velocity.vy[eid] * dtSec;
  }

  return world;
}
