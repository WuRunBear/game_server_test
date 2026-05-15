import { query } from "bitecs";

import { Collider, ColliderShape, Transform } from "components";
import { System as Check2dSystem, type Box, type Circle } from "check2d";
import type { EntityId, GameWorld } from "src/world";

type CircleBody = Circle<{ eid: EntityId }>;
type BoxBody = Box<{ eid: EntityId }>;
type CollisionBody = CircleBody | BoxBody;

type BodyRecord = {
  shape: number;
  body: CollisionBody;
};

/**
 * 碰撞系统运行期缓存。
 *
 * - 每个 World 维护一份 check2d System 与 “实体 -> 碰撞体” 的映射
 * - 使用 WeakMap 确保 World 被释放时缓存可被 GC 回收
 */
type CollisionRuntime = {
  system: Check2dSystem;
  bodies: Map<EntityId, BodyRecord>;
};

const runtimeByWorld = new WeakMap<GameWorld, CollisionRuntime>();

/**
 * 获取或初始化指定 World 的碰撞运行期缓存。
 *
 * @param world ECS World
 * @returns 该 World 对应的碰撞运行期缓存
 */
function getRuntime(world: GameWorld): CollisionRuntime {
  const existing = runtimeByWorld.get(world);
  if (existing) return existing;

  const created: CollisionRuntime = {
    system: new Check2dSystem(),
    bodies: new Map(),
  };
  runtimeByWorld.set(world, created);
  return created;
}

/**
 * 碰撞系统：使用 check2d 进行 2D 碰撞检测与分离，并把结果回写到 ECS Transform。
 *
 * 当前实现约定：
 * - Collider 支持圆形（radius）与盒子（halfW/halfH）
 * - 每 tick 会同步 Transform -> check2d，执行 separate()，再把位置写回 Transform
 *
 * @param world ECS World
 * @returns 处理后的 World
 */
export function collisionSystem(world: GameWorld): GameWorld {
  const rt = getRuntime(world);
  const alive = new Set<EntityId>();

  for (const eid of query(world, [Transform, Collider])) {
    const declaredShape = Collider.shape[eid];
    const radius = Collider.radius[eid] ?? 0;
    const halfW = Collider.halfW[eid] ?? 0;
    const halfH = Collider.halfH[eid] ?? 0;

    const shape =
      declaredShape === ColliderShape.Circle || declaredShape === ColliderShape.Box
        ? declaredShape
        : halfW > 0 && halfH > 0
          ? ColliderShape.Box
          : radius > 0
            ? ColliderShape.Circle
            : null;

    const existing = rt.bodies.get(eid);

    if (shape === ColliderShape.Circle) {
      if (radius <= 0) {
        if (existing) {
          rt.system.remove(existing.body);
          rt.bodies.delete(eid);
        }
        continue;
      }

      alive.add(eid);

      const x = Transform.x[eid];
      const y = Transform.y[eid];

      if (!existing || existing.shape !== ColliderShape.Circle) {
        if (existing) rt.system.remove(existing.body);
        const circle = rt.system.createCircle({ x, y }, radius, { userData: { eid } }) as CircleBody;
        rt.bodies.set(eid, { shape: ColliderShape.Circle, body: circle });
        continue;
      }

      const circle = existing.body as CircleBody;
      if (circle.r !== radius) {
        rt.system.remove(circle);
        const recreated = rt.system.createCircle({ x, y }, radius, { userData: { eid } }) as CircleBody;
        rt.bodies.set(eid, { shape: ColliderShape.Circle, body: recreated });
        continue;
      }

      circle.setPosition(x, y, false);
      circle.updateBody();
      continue;
    }

    if (shape === ColliderShape.Box) {
      const width = halfW * 2;
      const height = halfH * 2;
      if (width <= 0 || height <= 0) {
        if (existing) {
          rt.system.remove(existing.body);
          rt.bodies.delete(eid);
        }
        continue;
      }

      alive.add(eid);

      const x = Transform.x[eid];
      const y = Transform.y[eid];

      if (!existing || existing.shape !== ColliderShape.Box) {
        if (existing) rt.system.remove(existing.body);
        const box = rt.system.createBox({ x, y }, width, height, { userData: { eid } }) as BoxBody;
        rt.bodies.set(eid, { shape: ColliderShape.Box, body: box });
        continue;
      }

      const box = existing.body as BoxBody;
      if (box.width !== width) box.width = width;
      if (box.height !== height) box.height = height;
      box.setPosition(x, y, false);
      box.updateBody();
      continue;
    }

    if (existing) {
      rt.system.remove(existing.body);
      rt.bodies.delete(eid);
    }
    continue;
  }

  for (const [eid, record] of rt.bodies) {
    if (alive.has(eid)) continue;
    rt.system.remove(record.body);
    rt.bodies.delete(eid);
  }

  rt.system.separate();

  for (const [eid, record] of rt.bodies) {
    Transform.x[eid] = record.body.x;
    Transform.y[eid] = record.body.y;
  }

  return world;
}
