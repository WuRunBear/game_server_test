/**
 * 场景传送系统（tick 系统）。
 *
 * 玩家实体与 Portal 实体 AABB 相交时触发场景切换：
 * enterMap（换图 + 清场 + 布置 + 传送玩家至 Portal 声明坐标）。
 * 每 tick 至多触发一次（防多 portal 连锁切换）；目标图无效时不触发。
 *
 * 场景切换为房间级语义：所有玩家共享 world.map，任一玩家触发全员换图
 * （多人同场景协作模型，per-player 分图状态不在本切片范围）。
 */
import { query } from "bitecs";

import { Transform, Size, Player, Portal } from "components";
import { enterMap } from "framework/map/switchMap";
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

  for (const portal of portals) {
    const state = Portal[portal];
    if (!state || !state.targetMap) continue;

    for (const player of players) {
      if (!aabbOverlap(world, portal, player)) continue;
      if (enterMap(world, state.targetMap, { x: state.x, y: state.y })) {
        return world;
      }
    }
  }

  return world;
}
