import { query } from "bitecs";

import { Acceleration, Velocity } from "components";
import type { GameWorld } from "world";

export function physicsSystem(world: GameWorld): GameWorld {
  const dtSec = world.time.dtMs / 1000;

  for (const eid of query(world, [Velocity, Acceleration])) {
    Velocity.vx[eid] += Acceleration.ax[eid] * dtSec;
    Velocity.vy[eid] += Acceleration.ay[eid] * dtSec;
  }

  return world;
}
