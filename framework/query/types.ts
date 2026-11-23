/**
 * 查询面公共类型（framework/query/types.ts）。
 *
 * 所有 `/query/*` 端点共用同一成功/失败信封：失败只表达「对象不存在」这类
 * HTTP 层可映射为 404 的事实；具体业务不可用原因放在各数据体的 reason。
 *
 * 输出约定（CC-06 / §8.3）：
 * - 只读、无副作用、不推进 tick；
 * - 实体引用一律 networkId，响应中不出现 eid；
 * - 玩家/地图/NPC/配方不存在用 QueryErrorCode 表达（HTTP 404）。
 */
import { hasComponent, query } from "bitecs";

import { NetworkId, Player, entityMapOf } from "components";
import type { EntityId, GameWorld } from "world";

/** 查询失败的「对象不存在」类原因（HTTP 404）。 */
export type QueryErrorCode =
  | "player_not_found"
  | "npc_not_found"
  | "recipe_not_found"
  | "map_not_found";

/** 查询结果信封。 */
export type QueryResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: QueryErrorCode };

/** 通用成功构造器。 */
export function queryOk<T>(data: T): QueryResult<T> {
  return { ok: true, data };
}

/** 通用失败构造器。 */
export function queryFail(error: QueryErrorCode): QueryResult<never> {
  return { ok: false, error };
}

/** 按 networkId 找实体（不限标签）。 */
export function findEidByNetworkId(world: GameWorld, networkId: number): EntityId | undefined {
  if (!Number.isInteger(networkId) || networkId <= 0) return undefined;
  for (const eid of query(world, [NetworkId])) {
    if (NetworkId.value[eid] === networkId) return eid;
  }
  return undefined;
}

/**
 * 按 networkId 找玩家实体（必须带 Player 标签）。
 *
 * 非玩家实体 / 不存在 / 非法 id 一律 undefined——查询端点据此回 404。
 */
export function findPlayerEid(world: GameWorld, networkId: number): EntityId | undefined {
  const eid = findEidByNetworkId(world, networkId);
  if (eid === undefined) return undefined;
  return hasComponent(world, eid, Player) ? eid : undefined;
}

/** 玩家实体的地图存在性守卫：归属图未构建时返回 false（map_not_found 语义）。 */
export function playerMapExists(world: GameWorld, playerEid: EntityId): boolean {
  const mapId = entityMapOf(world, playerEid);
  return mapId === "" || world.maps[mapId] !== undefined;
}
