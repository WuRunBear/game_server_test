/**
 * 放置校验通用工具（游戏无关）。
 *
 * 提供「矩形占位（中心 x/y，宽 w 高 h）与实体/地图阻挡的冲突判定」
 * 以及「网格对齐 / 网格占用判定」，供放置系统做放置合法性校验。
 *
 * 所有判定均**按指定地图**进行：mapId 决定使用哪张地图的网格/阻挡，
 * 实体过滤也只考虑与该图同图的实体（不同图互不干扰）。
 *
 * v2 地图切片 6：三个判定均支持可选层号——提供 `level` 时只在同层判定
 * （异层实体/异层格组/异层楼板不构成冲突，同格多层共存）；缺省保持旧
 * 全层语义（既有调用零回归）。
 */
import { query } from "bitecs";
import { Collider, ColliderShape, GridOccupancy, Transform, entityMapOf } from "components";
import { entityLevelOf } from "framework/components/entityLevel";
import { walkableAtLevel, type BuiltFloorsByLevel } from "map/geometry/query";
import type { MapGeometry } from "map/geometry/types";
import type { GameWorld } from "world";

/**
 * 取某地图的几何（网格/阻挡来源）。空串归属（无图配置世界的哨兵）返回
 * undefined；非空 mapId 解析不到已构建图即抛含 mapId 的显式错误（归属异常
 * 是配置/存档 bug，不允许静默回退默认图）。
 */
function mapGeometryOf(world: GameWorld, mapId: string): MapGeometry | undefined {
  if (mapId === "") return undefined;
  const geometry = world.maps[mapId];
  if (!geometry) {
    throw new Error(`placement: map "${mapId}" is not present in world.maps`);
  }
  return geometry;
}

/**
 * 以 (x, y) 为中心、w×h 的矩形是否与 mapId 图上任何带 Collider 实体重叠（圆按包围盒近似）。
 *
 * @param level 可选层号：提供时只与同层实体判定（异层不构成放置冲突）
 */
export function overlapsAnyEntity(
  world: GameWorld,
  mapId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  level?: number,
): boolean {
  const halfW = w / 2;
  const halfH = h / 2;

  for (const eid of query(world, [Transform, Collider])) {
    if (entityMapOf(world, eid) !== mapId) continue;
    if (level !== undefined && entityLevelOf(eid) !== level) continue;
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
 * 网格对齐：把以 (x, y) 为中心、w×h 的占位矩形对齐到 mapId 地图的网格（tile 边界）。
 *
 * 对齐语义：占位矩形四角落在格线上——占格组 cellW×cellH（至少 1 格），
 * 格组左上角为 (cellX, cellY)，最终中心取格组中心。图不可解析时不对齐
 * （返回原坐标与空格组标记）。
 *
 * @returns 对齐后的中心坐标 + 格组；图不可解析时 cellW/cellH 为 0（不参与占用判定）
 */
export function snapToGrid(
  world: GameWorld,
  mapId: string,
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number; cellX: number; cellY: number; cellW: number; cellH: number } {
  const map = mapGeometryOf(world, mapId);
  if (!map) {
    return { x, y, cellX: 0, cellY: 0, cellW: 0, cellH: 0 };
  }

  const { tileWidth, tileHeight } = map.grid;
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

/**
 * 格组 (cellX, cellY, cellW, cellH) 与 mapId 图上任何带 GridOccupancy 实体的格组是否相交。
 *
 * @param cellLevel 可选占用层号：提供时只与同层格组判定（GridOccupancy.cellLevel；
 *   未写层号的既有放置物按 0 层参与判定）
 */
export function overlapsOccupiedGrid(
  world: GameWorld,
  mapId: string,
  cellX: number,
  cellY: number,
  cellW: number,
  cellH: number,
  cellLevel?: number,
): boolean {
  for (const eid of query(world, [GridOccupancy])) {
    if (entityMapOf(world, eid) !== mapId) continue;
    if (cellLevel !== undefined && (GridOccupancy.cellLevel[eid] ?? 0) !== cellLevel) continue;
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

/**
 * 以 (x, y) 为中心、w×h 的矩形是否压到 mapId 图的地图阻挡格。
 *
 * @param level 可选层号：提供时按层视角判定（walkableAtLevel：地形 OR 楼板
 *   建造，cliff 单向语义同源）；缺省保持旧的层级无关 walkable 位判定
 * @param built 可选建造索引（level 提供时生效；缺省仅地形）
 */
export function overlapsMapBlocked(
  world: GameWorld,
  mapId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  level?: number,
  built?: BuiltFloorsByLevel,
): boolean {
  const map = mapGeometryOf(world, mapId);
  if (!map) return false;

  const { width, height, tileWidth, tileHeight } = map.grid;
  const minTx = Math.floor((x - w / 2) / tileWidth);
  const maxTx = Math.floor((x + w / 2) / tileWidth);
  const minTy = Math.floor((y - h / 2) / tileHeight);
  const maxTy = Math.floor((y + h / 2) / tileHeight);

  for (let ty = Math.max(0, minTy); ty <= Math.min(height - 1, maxTy); ty += 1) {
    for (let tx = Math.max(0, minTx); tx <= Math.min(width - 1, maxTx); tx += 1) {
      const index = ty * width + tx;
      // 提供层号：walkableAtLevel 统一查询（与投射物/碰撞同源）；
      // 缺省：walkable=0 即阻挡格（MapGeometry 通行位图语义，与旧 blocked 取反等价）
      const blocked =
        level !== undefined
          ? !walkableAtLevel(map, tx, ty, level, built)
          : map.walkable[index] === 0;
      if (blocked) return true;
    }
  }

  return false;
}
