/**
 * 刷位放置通用工具（巢穴/袭击等周期刷怪系统共用，游戏无关）。
 *
 * 与放置链（placeableSystem）共用同一套占位合法性语义——全框架只有这一套：
 * footprintOf（Placeable 声明，16px 兜底）→ overlapsAnyEntity / overlapsMapBlocked。
 * 另含确定性尝试种子与「实体归属图解析」惯例（effectiveMapOf），供各刷怪系统复用。
 */
import { entityMapOf, footprintOf } from "components";
import { walkableAt } from "map/geometry/query";
import { spawnEntity } from "framework/entities/spawn";
import type { Rng } from "framework/map/generate/rng";
import { overlapsAnyEntity, overlapsMapBlocked } from "framework/utils/placement";
import type { MapGeometry } from "map/geometry/types";
import type { ArchetypeSpec } from "framework/entities/archetypeRegistry";
import type { GameWorld } from "world";

/** 单实体单门控的落位尝试上限（PLACEMENT_MAX_ATTEMPTS 惯例，同演化引擎选点）。 */
export const PLACEMENT_MAX_ATTEMPTS = 32;

/** 刷位搜索/计数缺省半径（tile）。 */
export const DEFAULT_SPAWN_RADIUS_TILES = 4;

/**
 * 确定性尝试种子：把 (tick, eid, slot, attempt) 混叠为一个 32 位整数。
 * 只求确定性（同输入恒同序列）；散列碰撞仅意味着两档尝试复用同一随机序列，无害。
 */
export function attemptSeed(
  tick: number,
  eid: number,
  slot: number,
  attempt: number,
): number {
  return (
    Math.imul(tick, 2654435761) ^
    Math.imul(eid, 40503) ^
    Math.imul(slot, 7919) ^
    Math.imul(attempt, 97)
  ) >>> 0;
}

/**
 * 刷怪判定的实体地图 id：mapId 解析不到已构建图（归属异常 = 配置/存档 bug）
 * 时**不改写归属**——记 error 并原样返回，由调用方对不可解析图跳过该实体
 * （interactionSystem/combatSystem 同款惯例）。
 */
export function effectiveMapOf(world: GameWorld, eid: number): string {
  const m = entityMapOf(world, eid);
  if (m !== "" && !world.maps[m]) {
    world.logger.error("entity mapId does not resolve to a known map; entity skipped", {
      eid,
      mapId: m,
    });
  }
  return m;
}

/**
 * 在像素锚点 (px, py)（占位矩形中心）尝试生成一枚 archetype 实体：
 * 锚点 tile 可走（walkableAt）+ 占位矩形不压同图实体/地图阻挡 → spawnEntity
 * （AoS 初始化钩子照常运行）。任一合法性不满足返回 false（零副作用）。
 */
export function trySpawnAtPixel(
  world: GameWorld,
  geometry: MapGeometry,
  mapId: string,
  archetype: ArchetypeSpec,
  px: number,
  py: number,
): boolean {
  const { tileWidth, tileHeight } = geometry.grid;
  if (!walkableAt(geometry, Math.floor(px / tileWidth), Math.floor(py / tileHeight))) {
    return false;
  }
  const { w, h } = footprintOf(archetype);
  if (overlapsAnyEntity(world, mapId, px, py, w, h)) return false;
  if (overlapsMapBlocked(world, mapId, px, py, w, h)) return false;
  spawnEntity(world, archetype, world.components_registry, { x: px, y: py, mapId });
  return true;
}

/**
 * (cx, cy) 中心 tile 半径 radiusTiles 的切比雪夫盒内随机取一 tile
 * （rng 注入保持确定性），返回该 tile 的像素中心坐标
 * （(tx + 0.5) * tileSize，与演化 spawn 通道同一换算）。
 */
export function randomTileCenterNear(
  rng: Rng,
  geometry: MapGeometry,
  cx: number,
  cy: number,
  radiusTiles: number,
): { px: number; py: number } {
  const span = 2 * radiusTiles + 1;
  const tx = cx + rng.int(span) - radiusTiles;
  const ty = cy + rng.int(span) - radiusTiles;
  return {
    px: (tx + 0.5) * geometry.grid.tileWidth,
    py: (ty + 0.5) * geometry.grid.tileHeight,
  };
}
