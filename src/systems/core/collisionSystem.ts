import { query } from "bitecs";

import { Collider, ColliderShape, Transform } from "components";
import Check2d, { type Box, type Circle, type System } from "check2d";
import type { EntityId, GameWorld } from "src/world";
import type { MapRuntime } from "map";

type CircleBody = Circle<{ eid: EntityId }>;
type BoxBody = Box<{ eid: EntityId }>;
type CollisionBody = CircleBody | BoxBody;

/**
 * 地图静态碰撞体。
 *
 * 说明：
 * - 地图碰撞体不属于 ECS 实体，不写入 rt.bodies，避免被“未存活清理”误删
 * - userData 仅用于调试区分来源
 */
type MapBody = Box<{ kind: "map" }>;

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
 * - 地图阻挡（blocked）会被转换为一批静态碰撞体缓存到 mapBodies
 */
type CollisionRuntime = {
  system: System;
  bodies: Map<EntityId, BodyRecord>;

  /**
   * 地图碰撞体缓存 key。
   *
   * 用于判断是否需要重建 mapBodies（例如地图切换或地图网格尺寸变化）。
   */
  mapKey?: string;

  /**
   * 地图静态碰撞体列表（由 blocked 网格生成）。
   *
   * 这些碰撞体会被插入到 check2d System，参与 separate()，但不会被移动（isStatic）。
   */
  mapBodies: MapBody[];
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
    mapBodies: [],
  };
  runtimeByWorld.set(world, created);
  return created;
}

/**
 * 生成地图碰撞体缓存 key。
 *
 * key 的设计目标：
 * - 同一张地图（id）与同一套网格参数下可复用已生成的 mapBodies
 * - 当地图 id 或网格参数变化时，触发重建
 *
 * @param map 地图运行时数据
 * @returns 用于缓存命中的字符串 key
 */
function mapKeyOf(map: MapRuntime): string {
  const g = map.grid;
  return `${map.id}:${g.width}x${g.height}:${g.tileWidth}x${g.tileHeight}`;
}

/**
 * blocked 网格合并后的矩形（以 tile 坐标表示，闭区间）。
 */
type TileRect = { x0: number; x1: number; y0: number; y1: number };

/**
 * 将阻挡网格（blocked）合并为更少的矩形。
 *
 * 合并策略：
 * - 先按行提取连续的阻挡区间 [x0, x1]
 * - 再把相邻行中区间完全相同的部分向下扩展，形成更大的矩形
 *
 * 这样通常能显著减少 check2d 中静态碰撞体数量，提高分离性能。
 *
 * @param blocked 阻挡网格（0=可走，1=阻挡），长度应为 width*height
 * @param width 网格宽度（tile 数）
 * @param height 网格高度（tile 数）
 * @returns 合并后的矩形列表（tile 坐标）
 */
function blockedToRects(blocked: Uint8Array, width: number, height: number): TileRect[] {
  const out: TileRect[] = [];
  let active = new Map<string, TileRect>();

  for (let y = 0; y < height; y++) {
    const next = new Map<string, TileRect>();

    let x = 0;
    while (x < width) {
      const idx = y * width + x;
      if (blocked[idx] !== 1) {
        x++;
        continue;
      }

      const x0 = x;
      x++;
      while (x < width && blocked[y * width + x] === 1) x++;
      const x1 = x - 1;

      const key = `${x0},${x1}`;
      const existing = active.get(key);
      if (existing) {
        existing.y1 = y;
        next.set(key, existing);
      } else {
        next.set(key, { x0, x1, y0: y, y1: y });
      }
    }

    for (const [key, rect] of active) {
      if (next.has(key)) continue;
      out.push(rect);
    }

    active = next;
  }

  for (const rect of active.values()) out.push(rect);
  return out;
}

/**
 * 清理并移除当前缓存的地图静态碰撞体。
 *
 * @param rt 碰撞运行期缓存
 */
function clearMapBodies(rt: CollisionRuntime): void {
  for (const body of rt.mapBodies) rt.system.remove(body);
  rt.mapBodies.length = 0;
  rt.mapKey = undefined;
}

/**
 * 确保地图静态碰撞体已构建并插入到 check2d System。
 *
 * 行为：
 * - map 不存在：清空已构建的地图碰撞体
 * - map 存在且 mapKey 变化：重建地图碰撞体
 * - map 存在且 mapKey 未变化：复用已有碰撞体
 *
 * @param rt 碰撞运行期缓存
 * @param map 当前 World 的地图运行时数据
 */
function ensureMapBodies(rt: CollisionRuntime, map: MapRuntime | undefined): void {
  if (!map) {
    if (rt.mapBodies.length > 0) clearMapBodies(rt);
    return;
  }

  const key = mapKeyOf(map);
  if (rt.mapKey === key) return;

  clearMapBodies(rt);

  const g = map.grid;
  const rects = blockedToRects(map.blocked, g.width, g.height);
  for (const r of rects) {
    const w = (r.x1 - r.x0 + 1) * g.tileWidth;
    const h = (r.y1 - r.y0 + 1) * g.tileHeight;
    const cx = ((r.x0 + r.x1 + 1) * 0.5) * g.tileWidth;
    const cy = ((r.y0 + r.y1 + 1) * 0.5) * g.tileHeight;
    const box = rt.system.createBox({ x: cx, y: cy }, w, h, {
      isStatic: true,
      userData: { kind: "map" },
    }) as MapBody;
    rt.mapBodies.push(box);
  }

  rt.mapKey = key;
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
  ensureMapBodies(rt, world.map);

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
