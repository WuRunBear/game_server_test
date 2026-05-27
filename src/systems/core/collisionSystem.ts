import { query } from "bitecs";

import { Collider, ColliderShape, Transform } from "components";
import Check2d, { type Box, type Circle, type System } from "check2d";
import type { EntityId, GameWorld } from "src/world";

type CircleBody = Circle<{ eid: EntityId }>;
type BoxBody = Box<{ eid: EntityId }>;
type CollisionBody = CircleBody | BoxBody;

type BodyRecord = {
  /**
   * 该实体当前使用的碰撞形状。
   *
   * 这里使用 ColliderShape 的数值枚举存储，便于快速判断是否需要重建 body。
   */
  shape: number;

  /**
   * check2d 中对应的刚体对象。
   *
   * 通过 userData.eid 与 ECS 实体关联；位置会在每 tick 同步与回写。
   */
  body: CollisionBody;
};

/**
 * 碰撞系统运行期缓存。
 *
 * - 每个 World 维护一份 check2d System 与 “实体 -> 碰撞体” 的映射
 * - 使用 WeakMap 确保 World 被释放时缓存可被 GC 回收
 */
type CollisionRuntime = {
  system: System;
  bodies: Map<EntityId, BodyRecord>;
};

const runtimeByWorld = new WeakMap<GameWorld, CollisionRuntime>();

/**
 * 获取或初始化指定 World 的碰撞运行期缓存。
 *
 * 该缓存用于避免每帧都重建 check2d System 与所有 body：
 * - 同一个 world 在整个生命周期内复用同一份 check2d System
 * - bodies 保存 “实体 -> check2d body” 的映射，实体组件变化时按需重建
 *
 * @param world ECS World
 * @returns 该 World 对应的碰撞运行期缓存
 */
function getRuntime(world: GameWorld): CollisionRuntime {
  const existing = runtimeByWorld.get(world);
  if (existing) return existing;

  const created: CollisionRuntime = {
    system: new Check2d.System(),
    bodies: new Map(),
  };
  runtimeByWorld.set(world, created);
  return created;
}

/**
 * 碰撞系统：使用 check2d 进行 2D 碰撞检测与分离，并把结果回写到 ECS Transform。
 *
 * 设计要点：
 * - check2d 侧维护一套 “可参与碰撞的 body 列表”，而 ECS 侧用组件描述实体的碰撞形状
 * - 本系统每 tick 做三件事：
 *   1) 同步：把 Transform 的位置同步到 body；Collider 尺寸变化时按需重建 body
 *   2) 分离：调用 separate() 让 check2d 计算并执行推开（解穿透）
 *   3) 回写：把 body 的最终位置写回 Transform，作为本 tick 的碰撞结果
 *
 * 形状判定规则：
 * - 如果 Collider.shape 显式设置为 Circle/Box，则以其为准
 * - 否则根据参数推断：halfW/halfH 有效则为 Box；radius 有效则为 Circle；都无效则视为无碰撞体
 *
 * @param world ECS World
 * @returns 处理后的 World
 */
export function collisionSystem(world: GameWorld): GameWorld {
  const rt = getRuntime(world);

  /**
   * 本 tick 仍然存活、且应当保留碰撞体的实体集合。
   *
   * 用于在遍历结束后清理已经不再匹配 query(Transform, Collider) 的旧 body：
   * - 实体被销毁
   * - Collider/Transform 被移除
   * - 形状参数无效导致本 tick 不创建 body
   */
  const alive = new Set<EntityId>();

  for (const eid of query(world, [Transform, Collider])) {
    const declaredShape = Collider.shape[eid];
    const radius = Collider.radius[eid] ?? 0;
    const halfW = Collider.halfW[eid] ?? 0;
    const halfH = Collider.halfH[eid] ?? 0;

    /**
     * 计算该实体本 tick 应当使用的碰撞形状。
     *
     * 注意：这里允许 Collider.shape 为空/非法值，此时退化为根据参数推断。
     */
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
      /**
       * 圆形碰撞体：radius 无效时移除已有 body；有效时同步位置并保证半径一致。
       * 半径变化会导致 check2d 的内部结构需要更新，这里选择直接重建 body。
       */
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
        /**
         * 该实体首次创建圆形 body，或原本是 Box 需要切换形状：
         * - 若存在旧 body，先从 check2d System 中移除
         * - 创建新的 circle 并写入映射
         */
        if (existing) rt.system.remove(existing.body);
        const circle = rt.system.createCircle({ x, y }, radius, { userData: { eid } }) as CircleBody;
        rt.bodies.set(eid, { shape: ColliderShape.Circle, body: circle });
        continue;
      }

      const circle = existing.body as CircleBody;
      if (circle.r !== radius) {
        /**
         * 半径变化：为了避免遗漏内部缓存更新，直接移除并重建。
         */
        rt.system.remove(circle);
        const recreated = rt.system.createCircle({ x, y }, radius, { userData: { eid } }) as CircleBody;
        rt.bodies.set(eid, { shape: ColliderShape.Circle, body: recreated });
        continue;
      }

      /**
       * 半径未变：仅同步位置。
       * - setPosition(..., false) 避免 check2d 立即触发额外处理
       * - updateBody() 用于更新内部 AABB / 广义碰撞等缓存
       */
      circle.setPosition(x, y, false);
      circle.updateBody();
      continue;
    }

    if (shape === ColliderShape.Box) {
      const width = halfW * 2;
      const height = halfH * 2;

      /**
       * 盒子碰撞体：尺寸无效时移除已有 body；有效时同步位置并更新尺寸。
       */
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
        /**
         * 该实体首次创建盒子 body，或原本是 Circle 需要切换形状。
         */
        if (existing) rt.system.remove(existing.body);
        const box = rt.system.createBox({ x, y }, width, height, { userData: { eid } }) as BoxBody;
        rt.bodies.set(eid, { shape: ColliderShape.Box, body: box });
        continue;
      }

      const box = existing.body as BoxBody;
      /**
       * 尺寸变化：box 允许直接改宽高，但仍需要 updateBody() 刷新内部结构。
       */
      if (box.width !== width) box.width = width;
      if (box.height !== height) box.height = height;
      box.setPosition(x, y, false);
      box.updateBody();
      continue;
    }

    /**
     * 本 tick 该实体不应当拥有碰撞体：
     * - 参数无效（radius/halfW/halfH 均无效）
     * - Collider.shape 非 Circle/Box 且无法推断
     *
     * 若存在旧 body，及时从 check2d 中移除并清理映射。
     */
    if (existing) {
      rt.system.remove(existing.body);
      rt.bodies.delete(eid);
    }
    continue;
  }

  /**
   * 清理“本 tick 未遍历到”的旧 body。
   *
   * 这些 body 通常来自：实体销毁 / 组件移除 / 临时变为无效形状。
   * 如果不清理，会导致幽灵碰撞体一直参与 separate()。
   */
  for (const [eid, record] of rt.bodies) {
    if (alive.has(eid)) continue;
    rt.system.remove(record.body);
    rt.bodies.delete(eid);
  }

  /**
   * 检查所有碰撞。
   *
   * checkAll() 会触发所有碰撞检测，包括已处理的碰撞。
   * 这里仅用于调试，实际应用中应注释掉。
   */
  rt.system.checkAll(result => {
    world.logger.info(JSON.stringify(result));
  });

  /**
   * 执行分离（解穿透）。
   *
   * separate() 会修改每个 body 的位置，使其不再与其他 body 重叠。
   */
  rt.system.separate();

  /**
   * 将 check2d 的结果位置回写到 ECS Transform。
   *
   * 约定：Transform 是权威位置；本系统在每 tick 的末尾把碰撞分离后的结果写回，供后续系统使用。
   */
  for (const [eid, record] of rt.bodies) {
    Transform.x[eid] = record.body.x;
    Transform.y[eid] = record.body.y;
  }

  return world;
}
