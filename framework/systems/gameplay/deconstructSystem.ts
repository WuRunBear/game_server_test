/**
 * 拆除系统（原子模块，无 tick 体）。
 *
 * 客户端经 PlayerCommand `deconstruct` 调用 deconstructEntity；服务端校验并变更：
 * 目标实体须为玩家放置物（Placeable）→ 所有权判定（仅放置者可拆，0=世界物不可拆）
 * → 距离范围校验（rules/place.json placeRange，统一距离助手）→ **stranded
 * 校验**（拆除层间连接器时，上层有人且无其他可达下行连接器则拒绝——防把
 * 人困死在高层，前置修正 8）→ destroyEntity。
 *
 * 校验全部在销毁之前完成：任一校验失败即拒绝，零副作用。
 * 拆除不返还材料（最小实现，回收机制留待真实需求）。
 */
import { hasComponent, query } from "bitecs";

import { Transform, NetworkId, Placeable, entityMapOf } from "components";
import { entityLevelOf } from "framework/components/entityLevel";
import {
  Structure,
  STRUCTURE_ROLE_NONE,
  STRUCTURE_ROLE_FLOOR,
  STRUCTURE_ROLE_CONNECTOR,
  CONNECTOR_DIR_DOWN,
} from "framework/components/structure";
import { isGameplayReachable } from "framework/utils/gameplayDistance";
import {
  bumpBuiltStructuresEpoch,
  collectBuiltStructures,
  floodSameLevel,
} from "framework/map/runtime/builtStructures";
import { destroyEntity } from "framework/entities/destroyEntity";
import type { EntityId, GameWorld } from "world";

interface PlaceRule {
  placeRange?: number;
}

const DEFAULT_PLACE_RANGE = 64;

/**
 * stranded 校验（前置修正 8）：拆除层间连接器是否会困死高层实体。
 *
 * 规则（确定性、有界成本）：
 * 1. 该图该高层（连接器 connectHigh）上没有任何实体 → 拆除无困死风险，放行；
 * 2. 有同图同高层（connectHigh 相同）的**其他下行连接器**（dir=down），
 *    且其所在格从被拆连接器格出发、在该高层上同层洪泛可达（可走 = 地形 OR
 *    楼板，墙阻挡）→ 上层实体可绕行另一楼梯下楼，放行；
 * 3. 其余（唯一连接器 / 替代连接器不可达）→ 拒绝拆除。
 *
 * 洪泛从被拆连接器格出发是对「上层实体位置」的保守代理：替代连接器与被拆
 * 连接器同层可达即认为上层连通；上层被墙体分割成互不连通的房间时按不可达
 * 处理（宁可拒绝、不困死人）。
 */
export function canRemoveConnector(world: GameWorld, connectorEid: EntityId): boolean {
  const mapId = entityMapOf(world, connectorEid);
  const geometry = world.maps[mapId];
  if (!geometry) return true; // 无图不拦（空图哨兵世界的防御分支）

  const high = Structure.connectHigh[connectorEid] ?? 0;
  const { width, tileWidth, tileHeight } = geometry.grid;
  const startTile =
    Math.floor(Transform.y[connectorEid] / tileHeight) * width +
    Math.floor(Transform.x[connectorEid] / tileWidth);

  // 1. 高层无人：拆除无困死风险（建造实体——楼板/墙/连接器——不算「人」，
  //    它们正是被困死的标的而非受困者）
  const hasOccupant = [...query(world, [Transform])].some((eid) => {
    if (eid === connectorEid) return false;
    if (hasComponent(world, eid, Structure)) return false;
    if (entityMapOf(world, eid) !== mapId) return false;
    return entityLevelOf(eid) === high;
  });
  if (!hasOccupant) return true;

  // 2/3. 其他下行连接器且同层可达 → 放行；否则拒绝
  const built = collectBuiltStructures(world, mapId);
  const reachable = floodSameLevel(geometry, built, startTile % width, Math.floor(startTile / width), high);
  for (const [tileIndex, connector] of built.connectors) {
    if (connector.eid === connectorEid) continue;
    if (connector.high !== high) continue;
    if (connector.dir !== CONNECTOR_DIR_DOWN) continue; // 只有下行连接器能下楼
    if (reachable.has(tileIndex)) return true;
  }
  return false;
}

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

  // 按 networkId 查目标 eid（实体量小，线性查找即可）
  let targetEid: EntityId | undefined;
  for (const eid of query(world, [NetworkId])) {
    if (NetworkId.value[eid] === targetNetworkId) {
      targetEid = eid;
      break;
    }
  }
  if (targetEid === undefined) return false;
  if (!hasComponent(world, targetEid, Placeable)) return false;
  if (entityMapOf(world, targetEid) !== entityMapOf(world, playerEid)) return false;

  // 所有权判定：无主（0）与非放置者不可拆
  const owner = Placeable.ownerNetworkId[targetEid] ?? 0;
  if (owner === 0) return false;
  if (owner !== NetworkId.value[playerEid]) return false;

  // 距离范围校验（与 placeEntity 同一规则源）+ 统一距离检查（前置修正 4）：
  // 同层欧氏距离；异层放置物不可达（不可隔层拆除）
  const rules = world.gameDef.resolvedRules["place"] as PlaceRule | undefined;
  const range = rules?.placeRange ?? DEFAULT_PLACE_RANGE;
  if (
    !isGameplayReachable(
      { x: Transform.x[playerEid], y: Transform.y[playerEid], level: entityLevelOf(playerEid) },
      { x: Transform.x[targetEid], y: Transform.y[targetEid], level: entityLevelOf(targetEid) },
      range,
    )
  ) {
    return false;
  }

  // stranded 校验（前置修正 8）：连接器拆除前确认上层不会被困死
  const structureRole = hasComponent(world, targetEid, Structure)
    ? (Structure.role[targetEid] ?? STRUCTURE_ROLE_NONE)
    : STRUCTURE_ROLE_NONE;
  if (structureRole === STRUCTURE_ROLE_CONNECTOR && !canRemoveConnector(world, targetEid)) {
    return false;
  }

  // 楼板拆除改变按层碰撞静态体 → 递增建造纪元（连接器/墙无静态体影响）
  if (structureRole === STRUCTURE_ROLE_FLOOR) {
    bumpBuiltStructuresEpoch(world, entityMapOf(world, targetEid));
  }

  destroyEntity(world, targetEid);
  return true;
}
