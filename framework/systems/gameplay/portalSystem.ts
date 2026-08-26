/**
 * 场景传送系统（tick 系统）。
 *
 * 对每个 portal × 每个玩家配对检查：玩家与 portal 所属同一地图
 * （entityMapOf 相等）且 AABB 相交时，仅移动该玩家到目标图与目标坐标
 * （movePlayerToMap）。同 tick 同一玩家至多移动一次（每玩家每 tick 单次，
 * 防连锁过户）；目标图无效（movePlayerToMap 返回 false）不移动、继续扫描。
 * 不同玩家互不影响（per-player 语义：任一玩家触发只切换自身地图）。
 */
import { query } from "bitecs";

import { Transform, Size, Player, Portal, entityMapOf } from "components";
import { movePlayerToMap } from "framework/map/switchMap";
import type { EntityId, GameWorld } from "world";

const DEFAULT_HALF_SIZE = 8;

/** 两实体的 AABB（中心 ± 半尺寸）是否相交或恰好接触（`<=`：碰撞系统
 *  把玩家分离到恰接触距离后仍可触发——严格小于会与 SAT 分离互斥，
 *  静态触发区 + 阻挡碰撞体组合下永不触发）。 */
function aabbOverlap(world: GameWorld, a: EntityId, b: EntityId): boolean {
  const aHalfW = (Size.w[a] ?? 0) / 2 || DEFAULT_HALF_SIZE;
  const aHalfH = (Size.h[a] ?? 0) / 2 || DEFAULT_HALF_SIZE;
  const bHalfW = (Size.w[b] ?? 0) / 2 || DEFAULT_HALF_SIZE;
  const bHalfH = (Size.h[b] ?? 0) / 2 || DEFAULT_HALF_SIZE;
  return (
    Math.abs(Transform.x[a] - Transform.x[b]) <= aHalfW + bHalfW &&
    Math.abs(Transform.y[a] - Transform.y[b]) <= aHalfH + bHalfH
  );
}

export function portalSystem(world: GameWorld): GameWorld {
  // Portal 为 AoS 组件（无 bitecs 组件标志，不能进 query）——按数据存在性筛选
  const portals = [...query(world, [Transform])].filter((eid) => Portal[eid] !== undefined);
  if (portals.length === 0) return world;

  const players = [...query(world, [Transform, Player])];
  if (players.length === 0) return world;

  const movedThisTick = new Set<number>();

  for (const portal of portals) {
    const state = Portal[portal];
    if (!state || !state.targetMap) continue;
    const portalMap = entityMapOf(world, portal);

    for (const player of players) {
      if (movedThisTick.has(player)) continue;
      if (entityMapOf(world, player) !== portalMap) continue;
      if (!aabbOverlap(world, portal, player)) continue;
      if (movePlayerToMap(world, player, state.targetMap, { x: state.x, y: state.y })) {
        movedThisTick.add(player);
      }
    }
  }

  return world;
}
