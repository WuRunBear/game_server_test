/**
 * 放置校验通用工具（游戏无关）。
 *
 * 提供「矩形占位（中心 x/y，宽 w 高 h）与实体/地图阻挡的冲突判定」
 * 以及「网格对齐 / 网格占用判定」，供放置系统做放置合法性校验。
 */
import { query } from "bitecs";
import { Collider, ColliderShape, GridOccupancy, Transform } from "components";
import type { GameWorld } from "world";

/**
 * 放置校验通用工具：矩形占位（中心 x/y，宽 w 高 h）与实体/地图阻挡的冲突判定，
 * 以及网格对齐/网格占用判定。供 placeableSystem 放置校验使用，不含游戏语义。
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

/**
 * 网格对齐：把以 (x, y) 为中心、w×h 的占位矩形对齐到地图网格（tile 边界）。
 *
 * 对齐语义：占位矩形四角落在格线上——占格组 cellW×cellH（至少 1 格），
 * 格组左上角为 (cellX, cellY)，最终中心取格组中心。无地图时不对齐
 * （返回原坐标与空格组标记）。
 *
 * @returns 对齐后的中心坐标 + 格组；world 无地图时 cellW/cellH 为 0（不参与占用判定）
 */
export function snapToGrid(
  world: GameWorld,
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number; cellX: number; cellY: number; cellW: number; cellH: number } {
  if (!world.map) {
    return { x, y, cellX: 0, cellY: 0, cellW: 0, cellH: 0 };
  }

  const { tileWidth, tileHeight } = world.map.grid;
  const cellW = Math.max(1, Math.round(w / tileWidth));
  const cellH = Math.max(1, Math.round(h / tileHeight));
  const cellX = Math.round(x / tileWidth - cellW / 2);
  const cellY = Math.round(y / tileHeight - cellH / 2);

  return {
    x: (cellX + cellW / 2) * tileWidth,
    y: (cellY + cellH / 2) * tileHeight,
    cellX,
    cellY,
    cellW,
    cellH,
  };
}

/** 格组 (cellX, cellY, cellW, cellH) 与任何带 GridOccupancy 实体的格组是否相交。 */
export function overlapsOccupiedGrid(
  world: GameWorld,
  cellX: number,
  cellY: number,
  cellW: number,
  cellH: number,
): boolean {
  for (const eid of query(world, [GridOccupancy])) {
    const ox = GridOccupancy.cellX[eid];
    const oy = GridOccupancy.cellY[eid];
    const ow = GridOccupancy.cellW[eid];
    const oh = GridOccupancy.cellH[eid];
    if (ow <= 0 || oh <= 0) continue;
    if (cellX < ox + ow && ox < cellX + cellW && cellY < oy + oh && oy < cellY + cellH) {
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
