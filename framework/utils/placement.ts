import { query } from "bitecs";
import { Collider, ColliderShape, Transform } from "components";
import type { GameWorld } from "world";

/**
 * 放置校验通用工具：矩形占位（中心 x/y，宽 w 高 h）与实体/地图阻挡的冲突判定。
 * 供 placeableSystem 放置校验使用，不含游戏语义。
 */

/** 以 (x, y) 为中心、w×h 的矩形是否与任何带 Collider 实体重叠（圆按包围盒近似）。 */
export function overlapsAnyEntity(world: GameWorld, x: number, y: number, w: number, h: number): boolean {
  const halfW = w / 2;
  const halfH = h / 2;

  for (const eid of query(world, [Transform, Collider])) {
    const isCircle = Collider.shape[eid] === ColliderShape.Circle;
    const eHalfW = isCircle ? (Collider.radius[eid] ?? 0) : (Collider.halfW[eid] ?? 0);
    const eHalfH = isCircle ? (Collider.radius[eid] ?? 0) : (Collider.halfH[eid] ?? 0);
    if (Math.abs(Transform.x[eid] - x) < halfW + eHalfW && Math.abs(Transform.y[eid] - y) < halfH + eHalfH) {
      return true;
    }
  }

  return false;
}

/** 以 (x, y) 为中心、w×h 的矩形是否压到地图阻挡格。无地图视为不阻挡。 */
export function overlapsMapBlocked(world: GameWorld, x: number, y: number, w: number, h: number): boolean {
  if (!world.map) return false;

  const { width, height, tileWidth, tileHeight } = world.map.grid;
  const minTx = Math.floor((x - w / 2) / tileWidth);
  const maxTx = Math.floor((x + w / 2) / tileWidth);
  const minTy = Math.floor((y - h / 2) / tileHeight);
  const maxTy = Math.floor((y + h / 2) / tileHeight);

  for (let ty = Math.max(0, minTy); ty <= Math.min(height - 1, maxTy); ty += 1) {
    for (let tx = Math.max(0, minTx); tx <= Math.min(width - 1, maxTx); tx += 1) {
      if (world.map.blocked[ty * width + tx] === 1) return true;
    }
  }

  return false;
}
