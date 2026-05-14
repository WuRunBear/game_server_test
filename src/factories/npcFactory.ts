import { addComponent, addEntity } from "bitecs";

import { Health, NPC, NetworkId, Transform } from "components";
import type { EntityId, GameWorld } from "world";

export interface CreateNpcOptions {
  x: number;
  y: number;
  kind: string;
}

export function createNpc(world: GameWorld, options: CreateNpcOptions): EntityId {
  const eid = addEntity(world);

  addComponent(world, eid, Transform);
  addComponent(world, eid, Health);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, NPC);

  Transform.x[eid] = options.x;
  Transform.y[eid] = options.y;
  Transform.rot[eid] = 0;
  Transform.scale[eid] = 1;

  Health.current[eid] = 50;
  Health.max[eid] = 50;

  NetworkId.value[eid] = eid;

  return eid;
}
