import { addComponent, addEntity } from "bitecs";

import { Health, NPC, NetworkId, Transform } from "components";
import type { EntityId, GameWorld } from "world";

export interface CreateNpcOptions {
  x: number;
  y: number;
  kind: string;
}

/**
 * 创建一个最小的 NPC 实体，并初始化必要组件的默认值。
 *
 * @param world ECS World
 * @param options 初始位置与 NPC 类型
 * @returns 新创建的实体 id
 */
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
