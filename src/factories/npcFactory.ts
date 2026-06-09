import { addComponent, addEntity } from "bitecs";

import { Collider, ColliderShape, Health, NPC, NetworkId, Size, Transform, Velocity } from "components";
import type { EntityId, GameWorld } from "world";

export interface CreateNpcOptions {
  x: number;
  y: number;
  kind: string;
  w?: number;
  h?: number;
  colliderShape?: (typeof ColliderShape)[keyof typeof ColliderShape];
  radius?: number;
}

/**
 * 创建一个最小的 NPC 实体，并初始化必要组件的默认值。
 *
 * @param world ECS World
 * @param options 初始位置、NPC 类型与可选尺寸/碰撞体参数
 * @returns 新创建的实体 id
 */
export function createNpc(world: GameWorld, options: CreateNpcOptions): EntityId {
  const eid = addEntity(world);

  addComponent(world, eid, Transform);
  addComponent(world, eid, Size);
  addComponent(world, eid, Velocity);
  addComponent(world, eid, Collider);
  addComponent(world, eid, Health);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, NPC);

  Transform.x[eid] = options.x;
  Transform.y[eid] = options.y;
  Transform.rot[eid] = 0;
  Transform.scale[eid] = 1;

  Velocity.vx[eid] = 0;
  Velocity.vy[eid] = 0;

  const defaultW = world.map ? world.map.grid.tileWidth : 16;
  const defaultH = world.map ? world.map.grid.tileHeight : 16;
  const w = options.w ?? defaultW;
  const h = options.h ?? defaultH;
  Size.w[eid] = w;
  Size.h[eid] = h;

  const shape = options.colliderShape ?? ColliderShape.Box;
  Collider.shape[eid] = shape;
  if (shape === ColliderShape.Circle) {
    const radius = options.radius ?? Math.min(w, h) * 0.5;
    Collider.radius[eid] = radius;
    Collider.halfW[eid] = 0;
    Collider.halfH[eid] = 0;
  } else {
    Collider.radius[eid] = 0;
    Collider.halfW[eid] = w;
    Collider.halfH[eid] = h;
  }

  Health.current[eid] = 50;
  Health.max[eid] = 50;

  NetworkId.value[eid] = eid;

  return eid;
}
