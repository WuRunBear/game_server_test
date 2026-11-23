/**
 * 交互候选（affordance）只读查询（`GET /query/affordances`）。
 *
 * 候选集合 = 与玩家**同图 + 同层**、距查询点位 ≤ radius 的交互相关实体
 * （Resource / Enemy / NPC·DialogueSource / Passage / Container / Placeable）；
 * 每个候选列出动作及可用性，不可用原因机器可读。
 *
 * 规则来源（不复制判定）：
 * - 同图/同层/距离：`entityMapOf` + `entityLevelOf` + `sameLevelDistance`；
 * - gather：`interactionRangeOf` + `hasRequiredTool` + ResourceNode 余量；
 * - attack：`attackReachOf` + Health/Attack/Cooldown（与 attackTarget 同源）；
 * - talk：`dialogueTalkRange` + DialogueSource/树存在 + NPC 存活；
 * - open：interaction 半径 + Passage；
 * - loot：`containerRangeOf` + Inventory；
 * - deconstruct：`deconstructBlockReason`（与拆除命令同一干跑）。
 *
 * 纯读：不写组件、不推进 tick、不发事件。
 */
import { hasComponent, query } from "bitecs";

import {
  Attack,
  Cooldown,
  Container,
  DialogueSource,
  Health,
  Inventory,
  Kind,
  NetworkId,
  NPC,
  Passage,
  Placeable,
  Resource,
  ResourceNode,
  Transform,
  Enemy,
  entityMapOf,
} from "components";
import { entityLevelOf } from "framework/components/entityLevel";
import { ActionState } from "framework/simulation/actions/actionState";
import { sameLevelDistance } from "framework/utils/gameplayDistance";
import {
  attackReachOf,
  interactionRangeOf,
} from "framework/systems/gameplay/interactionSystem";
import { dialogueTalkRange } from "framework/systems/gameplay/dialogueSystem";
import { hasRequiredTool } from "framework/systems/gameplay/gatheringSystem";
import { containerRangeOf, placeRangeOf } from "framework/systems/gameplay/placeableSystem";
import { deconstructBlockReason } from "framework/systems/gameplay/deconstructSystem";
import type { EntityId, GameWorld } from "world";
import {
  findPlayerEid,
  playerMapExists,
  queryFail,
  queryOk,
  type QueryResult,
} from "./types";

/** 动作 id（客户端按 id 映射 UI/表现）。 */
export type AffordanceActionId =
  | "gather"
  | "attack"
  | "talk"
  | "open"
  | "loot"
  | "deconstruct";

/** 不可用原因（机器可读；无法精确归因时不做猜测）。 */
export type AffordanceReason =
  | "out_of_range"
  | "no_tool"
  | "depleted"
  | "dead"
  | "blocked"
  | "cooldown"
  | "not_owner"
  | "empty"
  | "invalid"
  | "no_item";

/** 单个动作的可用性。 */
export interface AffordanceAction {
  id: AffordanceActionId;
  available: boolean;
  reason?: AffordanceReason;
  /** 该动作使用的判定半径（像素）；无距离语义的动作省略。 */
  range?: number;
}

/** 单个候选实体。 */
export interface AffordanceEntity {
  networkId: number;
  kind: string;
  x: number;
  y: number;
  level: number;
  /** 距查询点位的同层欧氏距离（像素）。 */
  distance: number;
  actions: AffordanceAction[];
}

/** `/query/affordances` 查询参数。 */
export interface AffordanceQuery {
  playerNetworkId: number;
  /** 缺省 = 玩家当前位置。 */
  x?: number;
  y?: number;
  /** 缺省 = 玩家当前层。 */
  level?: number;
  /** 候选扫描半径；缺省 = 各动作半径最大值。 */
  radius?: number;
}

/** `/query/affordances` 响应体。 */
export interface AffordancesResponse {
  entities: AffordanceEntity[];
}

/** 动作结果构造器（无 reason = 可用）。 */
function action(
  id: AffordanceActionId,
  range: number | undefined,
  reason: AffordanceReason | undefined,
): AffordanceAction {
  return {
    id,
    available: reason === undefined,
    ...(reason !== undefined ? { reason } : {}),
    ...(range !== undefined ? { range } : {}),
  };
}

/** 敌人/NPC 存活判定：带 Health 且 ≤ 0 = 死亡；无 Health 按存活。 */
function aliveAt(world: GameWorld, eid: EntityId): boolean {
  return !hasComponent(world, eid, Health) || (Health.current[eid] ?? 0) > 0;
}

/** 背包是否有可拿取的内容（空容器 = empty）。 */
function hasLoot(eid: EntityId): boolean {
  const inv = Inventory[eid];
  return inv !== undefined && inv.slots.some((slot) => slot !== null);
}

/** 候选扫描的缺省半径 = 全部动作半径的最大值。 */
function defaultRadius(world: GameWorld, playerEid: EntityId): number {
  return Math.max(
    interactionRangeOf(world),
    attackReachOf(world, playerEid),
    dialogueTalkRange(world),
    containerRangeOf(world),
    placeRangeOf(world),
  );
}

/**
 * 查询交互候选与动作可用性。
 *
 * @param world 游戏世界
 * @param input 查询参数（playerNetworkId 必填；坐标/层/半径可覆盖）
 * @returns 玩家/地图不存在时返回错误信封；否则 `{ entities }`
 */
export function queryAffordances(
  world: GameWorld,
  input: AffordanceQuery,
): QueryResult<AffordancesResponse> {
  const playerEid = findPlayerEid(world, input.playerNetworkId);
  if (playerEid === undefined) return queryFail("player_not_found");
  if (!playerMapExists(world, playerEid)) return queryFail("map_not_found");
  if (!hasComponent(world, playerEid, Transform)) return queryFail("player_not_found");

  const mapId = entityMapOf(world, playerEid);
  const px = input.x ?? Transform.x[playerEid];
  const py = input.y ?? Transform.y[playerEid];
  const level = input.level ?? entityLevelOf(playerEid);
  const radius = input.radius ?? defaultRadius(world, playerEid);

  const gatherRange = interactionRangeOf(world);
  const attackRange = attackReachOf(world, playerEid);
  const talkRange = dialogueTalkRange(world);
  const lootRange = containerRangeOf(world);
  const deconstructRange = placeRangeOf(world);

  const playerDead =
    hasComponent(world, playerEid, Health) && (Health.current[playerEid] ?? 0) <= 0;
  const playerHasAttack = hasComponent(world, playerEid, Attack);
  const existingAction = ActionState[playerEid];
  // 不可打断的动作锁定：gather/attack 启动会被拒绝（startConfiguredAction 同判）
  const actionLocked = existingAction !== undefined && !existingAction.interruptible;
  // 可打断动作存在时新动作允许打断并重起冷却（与 startConfiguredAction 一致）
  const playerCoolingDown =
    hasComponent(world, playerEid, Cooldown) &&
    (Cooldown.remainingMs[playerEid] ?? 0) > 0 &&
    existingAction?.interruptible !== true;

  const entities: AffordanceEntity[] = [];

  for (const eid of query(world, [Transform, NetworkId])) {
    if (eid === playerEid) continue;
    if (entityMapOf(world, eid) !== mapId) continue;

    const distance = sameLevelDistance(
      px,
      py,
      level,
      Transform.x[eid],
      Transform.y[eid],
      entityLevelOf(eid),
    );
    // 异层不可交互；半径外不构成候选
    if (distance === undefined || distance > radius) continue;

    const actions: AffordanceAction[] = [];

    if (hasComponent(world, eid, Resource)) {
      const node = ResourceNode[eid];
      let reason: AffordanceReason | undefined;
      if (playerDead) reason = "dead";
      else if (actionLocked) reason = "blocked";
      else if (distance > gatherRange) reason = "out_of_range";
      else if (!node) reason = "invalid";
      else if (!node.infinite && node.remaining <= 0) reason = "depleted";
      else if (
        !(node.lootTable && node.lootTable.length > 0) &&
        !world.gameDef.itemsByKind?.has(node.yieldsKind)
      ) {
        reason = "invalid";
      } else if (!hasRequiredTool(world, playerEid, eid)) reason = "no_tool";
      actions.push(action("gather", gatherRange, reason));
    }

    if (hasComponent(world, eid, Enemy)) {
      let reason: AffordanceReason | undefined;
      if (playerDead) reason = "dead";
      else if (!playerHasAttack) reason = "invalid";
      else if (!hasComponent(world, eid, Health)) reason = "invalid";
      else if (!aliveAt(world, eid)) reason = "dead";
      else if (distance > attackRange) reason = "out_of_range";
      else if (actionLocked) reason = "blocked";
      else if (playerCoolingDown) reason = "cooldown";
      actions.push(action("attack", attackRange, reason));
    }

    const dialogueSource = DialogueSource[eid];
    if (hasComponent(world, eid, NPC) || dialogueSource !== undefined) {
      let reason: AffordanceReason | undefined;
      if (playerDead) reason = "dead";
      else if (!aliveAt(world, eid)) reason = "dead";
      else if (!dialogueSource?.treeId) reason = "invalid";
      else if (!world.gameDef.dialoguesByKind?.has(dialogueSource.treeId)) reason = "invalid";
      else if (distance > talkRange) reason = "out_of_range";
      actions.push(action("talk", talkRange, reason));
    }

    if (hasComponent(world, eid, Passage)) {
      const reason = playerDead
        ? "dead"
        : distance > gatherRange
          ? "out_of_range"
          : undefined;
      actions.push(action("open", gatherRange, reason));
    }

    if (hasComponent(world, eid, Container)) {
      let reason: AffordanceReason | undefined;
      if (playerDead) reason = "dead";
      else if (distance > lootRange) reason = "out_of_range";
      else if (!hasLoot(eid)) reason = "empty";
      actions.push(action("loot", lootRange, reason));
    }

    if (hasComponent(world, eid, Placeable)) {
      const block = deconstructBlockReason(world, playerEid, eid);
      let reason: AffordanceReason | undefined;
      if (playerDead) reason = "dead";
      else if (distance > deconstructRange) reason = "out_of_range";
      else if (block !== undefined) reason = block;
      actions.push(action("deconstruct", deconstructRange, reason));
    }

    if (actions.length === 0) continue;

    entities.push({
      networkId: NetworkId.value[eid],
      kind: Kind[eid] ?? "",
      x: Transform.x[eid],
      y: Transform.y[eid],
      level: entityLevelOf(eid),
      distance,
      actions,
    });
  }

  // 稳定顺序：先近后远，同距离按 networkId。
  entities.sort((a, b) => a.distance - b.distance || a.networkId - b.networkId);

  return queryOk({ entities });
}
