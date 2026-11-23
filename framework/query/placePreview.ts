/**
 * 放置预览（`POST /query/place`）——placeableSystem 干跑 + 占用投影。
 *
 * `valid/reason` 直接来自 `planPlacement`（与 place 命令同一函数），本模块只做
 * **只读**的展示数据补充：footprint（像素）、覆盖格、占位实体（networkId/kind）。
 * 不消耗物品、不 spawn、不写 GridOccupancy。
 */
import { hasComponent, query } from "bitecs";

import {
  Collider,
  ColliderShape,
  GridOccupancy,
  Kind,
  NetworkId,
  Placeable,
  Transform,
  entityMapOf,
} from "components";
import { entityLevelOf } from "framework/components/entityLevel";
import {
  planPlacement,
  type PlaceFailureReason,
  type PlacePlan,
} from "framework/systems/gameplay/placeableSystem";
import { deconstructBlockReason } from "framework/systems/gameplay/deconstructSystem";
import type { EntityId, GameWorld } from "world";
import type { MapGeometry } from "map/geometry/types";
import {
  findPlayerEid,
  playerMapExists,
  queryFail,
  queryOk,
  type QueryResult,
} from "./types";

/** 占位实体（不含 eid；owner/canDeconstruct 仅对 Placeable 输出）。 */
export interface PlaceOccupant {
  networkId: number;
  kind: string;
  ownerNetworkId?: number;
  canDeconstruct?: boolean;
}

/** `/query/place` 查询参数。 */
export interface PlaceQuery {
  playerNetworkId: number;
  slot: number;
  x: number;
  y: number;
}

/** `/query/place` 响应体。 */
export interface PlacePreview {
  valid: boolean;
  reason?: PlaceFailureReason;
  /** 占位尺寸（像素）；物品不可放置/物品不存在时为 0×0。 */
  footprint: { w: number; h: number };
  /** 覆盖的地图格（tile 坐标 `[x, y]`；无图/无占位时为 []）。 */
  cells: Array<[number, number]>;
  /** 目标位（同图同层）与占位矩形重叠的实体。 */
  occupiedBy: PlaceOccupant[];
  /** 占位实体的 owner（有占位 Placeable 时）或新放置物的 owner。 */
  ownerNetworkId?: number;
  /** 占位实体中是否有当前玩家可拆除的对象。 */
  canDeconstruct?: boolean;
  /** 网格对齐后的最终中心坐标（预览/命令一致）。 */
  x?: number;
  y?: number;
  level?: number;
}

/** 矩形 [x±w/2, y±h/2] 是否与实体碰撞体重叠。 */
function overlapsCollider(world: GameWorld, eid: EntityId, x: number, y: number, w: number, h: number): boolean {
  if (!hasComponent(world, eid, Collider)) return false;
  const halfW = w / 2;
  const halfH = h / 2;
  const isCircle = Collider.shape[eid] === ColliderShape.Circle;
  const eHalfW = isCircle ? (Collider.radius[eid] ?? 0) : (Collider.halfW[eid] ?? 0);
  const eHalfH = isCircle ? (Collider.radius[eid] ?? 0) : (Collider.halfH[eid] ?? 0);
  return (
    Math.abs(Transform.x[eid] - x) < halfW + eHalfW &&
    Math.abs(Transform.y[eid] - y) < halfH + eHalfH
  );
}

/** 网格占用实体是否与计划格组重叠（与 overlapsOccupiedGrid 同口径）。 */
function overlapsGrid(
  world: GameWorld,
  eid: EntityId,
  cell: NonNullable<PlacePlan["cell"]>,
  level: number,
): boolean {
  if (!hasComponent(world, eid, GridOccupancy)) return false;
  if ((GridOccupancy.cellLevel[eid] ?? 0) !== level) return false;
  const ox = GridOccupancy.cellX[eid];
  const oy = GridOccupancy.cellY[eid];
  const ow = GridOccupancy.cellW[eid];
  const oh = GridOccupancy.cellH[eid];
  if (ow <= 0 || oh <= 0) return false;
  return (
    cell.cellX < ox + ow &&
    ox < cell.cellX + cell.cellW &&
    cell.cellY < oy + oh &&
    oy < cell.cellY + cell.cellH
  );
}

/** 按最终中心/尺寸投影覆盖格（半开区间，避免边界格重复计入）。 */
function coveredCells(
  geometry: MapGeometry | undefined,
  plan: PlacePlan,
): Array<[number, number]> {
  if (!geometry || plan.footprintW <= 0 || plan.footprintH <= 0) return [];
  const { tileWidth, tileHeight } = geometry.grid;
  const minTx = Math.floor((plan.targetX - plan.footprintW / 2) / tileWidth);
  const maxTx = Math.max(minTx, Math.ceil((plan.targetX + plan.footprintW / 2) / tileWidth) - 1);
  const minTy = Math.floor((plan.targetY - plan.footprintH / 2) / tileHeight);
  const maxTy = Math.max(minTy, Math.ceil((plan.targetY + plan.footprintH / 2) / tileHeight) - 1);

  const cells: Array<[number, number]> = [];
  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) cells.push([tx, ty]);
  }
  return cells;
}

/**
 * 放置预览：干跑校验 + 占位投影。
 *
 * 即使 `valid=false`（如 out_of_range/blocked），只要物品可放置仍返回
 * footprint/cells/occupiedBy，便于客户端画红框并解释原因。
 */
export function queryPlace(world: GameWorld, input: PlaceQuery): QueryResult<PlacePreview> {
  const playerEid = findPlayerEid(world, input.playerNetworkId);
  if (playerEid === undefined) return queryFail("player_not_found");
  if (!playerMapExists(world, playerEid)) return queryFail("map_not_found");
  if (!hasComponent(world, playerEid, Transform)) return queryFail("player_not_found");

  const result = planPlacement(world, playerEid, input.slot, input.x, input.y);
  const plan = result.plan;
  if (!plan) {
    return queryOk({
      valid: false,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      footprint: { w: 0, h: 0 },
      cells: [],
      occupiedBy: [],
    });
  }

  const geometry = world.maps[plan.placerMap];
  const cells = coveredCells(geometry, plan);
  const occupants: PlaceOccupant[] = [];
  let firstPlaceableOwner: number | undefined;
  let anyDeconstructable = false;

  for (const eid of query(world, [Transform, NetworkId])) {
    if (entityMapOf(world, eid) !== plan.placerMap) continue;
    if (entityLevelOf(eid) !== plan.placedLevel) continue;

    const colliderHit = overlapsCollider(
      world,
      eid,
      plan.targetX,
      plan.targetY,
      plan.footprintW,
      plan.footprintH,
    );
    const gridHit = plan.cell !== undefined && overlapsGrid(world, eid, plan.cell, plan.placedLevel);
    if (!colliderHit && !gridHit) continue;

    const occupant: PlaceOccupant = {
      networkId: NetworkId.value[eid],
      kind: Kind[eid] ?? "",
    };
    if (hasComponent(world, eid, Placeable)) {
      const owner = Placeable.ownerNetworkId[eid] ?? 0;
      occupant.ownerNetworkId = owner;
      const canDeconstruct = deconstructBlockReason(world, playerEid, eid) === undefined;
      occupant.canDeconstruct = canDeconstruct;
      anyDeconstructable ||= canDeconstruct;
      firstPlaceableOwner ??= owner;
    }
    occupants.push(occupant);
  }

  // 新放置物的 owner：目标原型带 Placeable 时由 placeEntity 写入放置者 networkId。
  // 有占位实体但都不是 Placeable（树/生物等）时不冒充 owner。
  const newOwner = plan.archetype.components["Placeable"]
    ? NetworkId.value[playerEid]
    : undefined;
  const ownerNetworkId =
    firstPlaceableOwner ?? (occupants.length === 0 ? newOwner : undefined);

  return queryOk({
    valid: result.reason === undefined,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    footprint: { w: plan.footprintW, h: plan.footprintH },
    cells,
    occupiedBy: occupants,
    ...(ownerNetworkId !== undefined ? { ownerNetworkId } : {}),
    canDeconstruct: anyDeconstructable,
    x: plan.targetX,
    y: plan.targetY,
    level: plan.placedLevel,
  });
}
