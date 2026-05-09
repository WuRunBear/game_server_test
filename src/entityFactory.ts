import { addComponent, addEntity } from "bitecs";

import { Acceleration, Health, NetworkId, Player, Transform, Velocity } from "./components";
import type { EntityId, GameWorld } from "./world";

export interface CreatePlayerOptions {
  x: number;
  y: number;
}

/**
 * 创建一个最小的玩家实体，并初始化必要组件的默认值。
 *
 * @param world ECS World
 * @param options 初始位置
 * @returns 新创建的实体 id
 */
export function createPlayer(world: GameWorld, options: CreatePlayerOptions): EntityId {
  const eid = addEntity(world);

  addComponent(world, eid, Transform);
  addComponent(world, eid, Velocity);
  addComponent(world, eid, Acceleration);
  addComponent(world, eid, Health);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);

  Transform.x[eid] = options.x;
  Transform.y[eid] = options.y;
  Transform.rot[eid] = 0;
  Transform.scale[eid] = 1;

  Velocity.vx[eid] = 0;
  Velocity.vy[eid] = 0;

  Acceleration.ax[eid] = 0;
  Acceleration.ay[eid] = 0;

  Health.current[eid] = 100;
  Health.max[eid] = 100;

  NetworkId.value[eid] = eid;

  return eid;
}
