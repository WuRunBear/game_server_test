import { query } from "bitecs";

import { Acceleration, Velocity } from "components";
import type { GameWorld } from "world";

/**
 * 物理系统：把加速度积分到速度上（v += a * dt）。
 *
 * @param world ECS World
 * @returns 处理后的 World
 */
export function physicsSystem(world: GameWorld): GameWorld {
  const dtSec = world.time.dtMs / 1000;

  for (const eid of query(world, [Velocity, Acceleration])) {
    Velocity.vx[eid] += Acceleration.ax[eid] * dtSec;
    Velocity.vy[eid] += Acceleration.ay[eid] * dtSec;
  }

  return world;
}
