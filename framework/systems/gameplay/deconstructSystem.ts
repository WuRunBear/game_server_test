/**
 * 拆除系统（原子模块，无 tick 体）。
 *
 * 客户端经 PlayerCommand `deconstruct` 调用 deconstructEntity；服务端校验并变更：
 * 目标实体须为玩家放置物（Placeable）→ 所有权判定（仅放置者可拆，0=世界物不可拆）
 * → 距离范围校验（rules/place.json placeRange）→ destroyEntity。
 *
 * 校验全部在销毁之前完成：任一校验失败即拒绝，零副作用。
 * 拆除不返还材料（即需即补，回收机制留待真实需求）。
 */
import { hasComponent, query } from "bitecs";

import { Transform, NetworkId, Placeable } from "components";
import { destroyEntity } from "framework/entities/destroyEntity";
import type { EntityId, GameWorld } from "world";

interface PlaceRule {
  placeRange?: number;
}

const DEFAULT_PLACE_RANGE = 64;

/**
 * 拆除原子：拆除玩家放置的建造物（仅放置者可拆）。
 *
 * @param world 游戏世界
 * @param playerEid 执行者实体
 * @param targetNetworkId 目标放置物的 networkId
 * @returns 是否拆除成功
 */
export function deconstructEntity(
  world: GameWorld,
  playerEid: EntityId,
  targetNetworkId: number,
): boolean {
  if (!Number.isInteger(targetNetworkId) || targetNetworkId <= 0) return false;

  // 按 networkId 查目标 eid（实体量小，线性查找即需即补）
  let targetEid: EntityId | undefined;
  for (const eid of query(world, [NetworkId])) {
    if (NetworkId.value[eid] === targetNetworkId) {
      targetEid = eid;
      break;
    }
  }
  if (targetEid === undefined) return false;
  if (!hasComponent(world, targetEid, Placeable)) return false;

  // 所有权判定：无主（0）与非放置者不可拆
  const owner = Placeable.ownerNetworkId[targetEid] ?? 0;
  if (owner === 0) return false;
  if (owner !== NetworkId.value[playerEid]) return false;

  // 距离范围校验（与 placeEntity 同一规则源）
  const rules = world.gameDef.resolvedRules["place"] as PlaceRule | undefined;
  const range = rules?.placeRange ?? DEFAULT_PLACE_RANGE;
  const dist = Math.hypot(
    Transform.x[targetEid] - Transform.x[playerEid],
    Transform.y[targetEid] - Transform.y[playerEid],
  );
  if (dist > range) return false;

  destroyEntity(world, targetEid);
  return true;
}
