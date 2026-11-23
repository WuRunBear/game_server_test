/**
 * 放置系统（原子模块，无 tick 体）。
 *
 * 客户端经 PlayerCommand `place` 调用 placeEntity；服务端校验并变更：
 * 物品 kind 声明 `place.archetype`（要放置成哪种实体）→ 校验占位尺寸来源
 * （Placeable 组件配置，未声明按 16×16 兜底——与演化链 footprint 同源，
 * 见 components/placeable.ts 的 footprintOf）→ 距离 / 实体重叠 / 地图阻挡
 * 校验（零副作用）→ 消耗 1 个该物品 → spawnEntity 目标 archetype。
 *
 * S6 扩展（建造闭环）：
 * - 网格对齐：rules/place.json 的 `gridSnap`（缺省 false 保持旧行为）开启时，
 *   占位矩形对齐地图网格（snapToGrid），最终坐标取对齐后格组中心
 * - 网格占用：对齐后写入 GridOccupancy（格组），放置校验加格组冲突判定
 *   （同格重放被拒）——墙/地板可无缝拼接，且不会叠放
 * - 所有权：spawn 后写 Placeable.ownerNetworkId（放置者 networkId），
 *   供 deconstruct（仅放置者可拆）判定；无主放置物（0）不可拆
 *
 * v2 地图切片 6（多层建造）：
 * - **层号**：放置物落放置者层号；楼板角色（Structure.role=floor）升一层
 *   ——在 (x, y, L+1) 提供可站面，其下的 L 格成为「有顶」；连接器角色
 *   （connector）的连接范围按放置层派生（上行：L↔L+1；下行：L-1↔L）
 * - 格组占用升为 (格, 层)：同格不同层共存（L0 家具上方放 L1 楼板），
 *   GridOccupancy.cellLevel 记录占用层
 * - 校验按层判定：实体重叠 / 地图阻挡 / 格组冲突均只看同层（异层互不妨碍）
 * - 楼板放置/拆除改变按层碰撞静态体 → 递增该图建造纪元（碰撞运行时重建）
 *
 * 校验全部在消耗之前完成：任一校验失败即拒绝，不留半成品状态。
 * 放置范围经 rules/place.json 的 placeRange 配置（缺省 64）。
 */
import { Transform, Inventory, NetworkId, Placeable, GridOccupancy, entityMapOf, footprintOf } from "components";
import type { ItemStack } from "components";
import { entityLevelOf } from "framework/components/entityLevel";
import {
  Structure,
  STRUCTURE_ROLE_NONE,
  STRUCTURE_ROLE_FLOOR,
  STRUCTURE_ROLE_CONNECTOR,
  CONNECTOR_DIR_UP,
  CONNECTOR_DIR_DOWN,
} from "framework/components/structure";
import { isGameplayReachable } from "framework/utils/gameplayDistance";
import { spawnEntity } from "framework/entities/spawn";
import { bumpBuiltStructuresEpoch } from "framework/map/runtime/builtStructures";
import { collectBuiltStructures } from "framework/map/runtime/builtStructures";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { ArchetypeRegistry, ArchetypeSpec } from "framework/entities/archetypeRegistry";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";
import {
  overlapsAnyEntity,
  overlapsMapBlocked,
  overlapsOccupiedGrid,
  snapToGrid,
} from "framework/utils/placement";
import type { EntityId, GameWorld } from "world";

interface PlaceRule {
  placeRange?: number;
  /** 是否把占位矩形对齐到地图网格（缺省 false 保持任意坐标放置）。 */
  gridSnap?: boolean;
}

const DEFAULT_PLACE_RANGE = 64;

/** 原型 Structure 组件配置（archetype.components["Structure"] 的声明形态）。 */
interface StructureConfig {
  role?: number;
  connectDir?: number;
}

/** 放置失败原因（与 place 命令错误码同一套语义）。 */
export type PlaceFailureReason = "no_item" | "invalid" | "out_of_range" | "blocked";

/** 干跑解析出的放置计划（校验通过或失败后可用于预览）。 */
export interface PlacePlan {
  stack: ItemStack;
  item: ItemKindSpec;
  archetype: ArchetypeSpec;
  /** 网格对齐后的最终中心坐标（未开启 gridSnap 时 = 请求坐标）。 */
  targetX: number;
  targetY: number;
  footprintW: number;
  footprintH: number;
  /** 网格对齐后的格组（未开启 gridSnap / 无图时不提供）。 */
  cell?: { cellX: number; cellY: number; cellW: number; cellH: number };
  /** 放置落位层号（楼板角色升一层）。 */
  placedLevel: number;
  /** 建造角色（STRUCTURE_ROLE_*）。 */
  role: number;
  structure?: StructureConfig;
  placerMap: string;
}

/** `planPlacement` 结果：plan 尽量给出（预览用），reason 表示是否可放置。 */
export interface PlacePlanResult {
  plan?: PlacePlan;
  reason?: PlaceFailureReason;
}

/**
 * 放置干跑（只读、零副作用）：与 `placeEntity` 共用全部校验顺序。
 *
 * 校验项（任一失败即返回 reason，plan 仍尽量带出已解析部分）：
 * 槽位物品存在/可放置 → 原型存在 → 距离 → 网格对齐/格组占用 → 实体重叠
 * → 地图阻挡。命令路径与 `POST /query/place` 都经本函数，规则只有一份。
 */
export function planPlacement(
  world: GameWorld,
  playerEid: EntityId,
  slot: number,
  x: number,
  y: number,
): PlacePlanResult {
  const inv = Inventory[playerEid];
  if (!inv) return { reason: "no_item" };
  const stack = inv.slots[slot];
  if (!stack) return { reason: "no_item" };

  const item = world.gameDef.itemsByKind?.get(stack.kind);
  if (!item?.place) return { reason: "invalid" };

  const archetypeRegistry = world.archetypes as ArchetypeRegistry;
  if (!archetypeRegistry.has(item.place.archetype)) return { reason: "invalid" };
  const archetype = archetypeRegistry.get(item.place.archetype);
  if (!archetype) return { reason: "invalid" };

  const rules = world.gameDef.resolvedRules["place"] as PlaceRule | undefined;
  const range = placeRangeOf(world);

  const placerMap = entityMapOf(world, playerEid);
  const placerLevel = entityLevelOf(playerEid);

  // 建造角色与落位层号：楼板升一层（在放置者层之上提供可站面）；
  // 墙/连接器/普通放置物落放置者层号
  const structure = archetype.components["Structure"] as StructureConfig | undefined;
  const role = structure?.role ?? STRUCTURE_ROLE_NONE;
  const placedLevel =
    role === STRUCTURE_ROLE_FLOOR ? placerLevel + 1 : placerLevel;

  const { w, h } = footprintOf(archetype);
  const plan: PlacePlan = {
    stack,
    item,
    archetype,
    targetX: x,
    targetY: y,
    footprintW: w,
    footprintH: h,
    placedLevel,
    role,
    ...(structure !== undefined ? { structure } : {}),
    placerMap,
  };

  // 统一距离检查（前置修正 4）：目标点位取放置者层号（同层平面欧氏距离）
  if (
    !isGameplayReachable(
      { x: Transform.x[playerEid], y: Transform.y[playerEid], level: placerLevel },
      { x, y, level: placerLevel },
      range,
    )
  ) {
    return { plan, reason: "out_of_range" };
  }

  // 网格对齐（gridSnap 开启）：目标坐标取对齐后格组中心，并校验格组占用
  // （按落位层判定——同格不同层共存，如 L0 家具上方的 L1 楼板）
  if (rules?.gridSnap) {
    const snapped = snapToGrid(world, placerMap, x, y, w, h);
    plan.targetX = snapped.x;
    plan.targetY = snapped.y;
    if (snapped.cellW > 0 && snapped.cellH > 0) {
      plan.cell = snapped;
      if (
        overlapsOccupiedGrid(
          world,
          placerMap,
          snapped.cellX,
          snapped.cellY,
          snapped.cellW,
          snapped.cellH,
          placedLevel,
        )
      ) {
        return { plan, reason: "blocked" };
      }
    }
  }

  // 实体重叠 / 地图阻挡均按落位层判定（异层实体与异层楼板不构成冲突；
  // 阻挡判定含建造楼板——楼板层视角下其覆盖格可站）
  const built = collectBuiltStructures(world, placerMap);
  if (overlapsAnyEntity(world, placerMap, plan.targetX, plan.targetY, w, h, placedLevel)) {
    return { plan, reason: "blocked" };
  }
  if (overlapsMapBlocked(world, placerMap, plan.targetX, plan.targetY, w, h, placedLevel, built)) {
    return { plan, reason: "blocked" };
  }

  return { plan };
}

/** 放置范围（rules/place.json placeRange，缺省 64）。 */
export function placeRangeOf(world: GameWorld): number {
  const rules = world.gameDef.resolvedRules["place"] as PlaceRule | undefined;
  return rules?.placeRange ?? DEFAULT_PLACE_RANGE;
}

/** 容器取回范围（rules/place.json containerRange，缺省 64）。 */
export function containerRangeOf(world: GameWorld): number {
  const rules = world.gameDef.resolvedRules["place"] as
    | (PlaceRule & { containerRange?: number })
    | undefined;
  return rules?.containerRange ?? DEFAULT_PLACE_RANGE;
}

/**
 * 放置原子：把玩家背包 slot 中的可放置物品放置到 (x, y)。
 *
 * @param world 游戏世界
 * @param playerEid 执行者实体
 * @param slot 背包槽位（物品 kind 须声明 place.archetype）
 * @param x / y 目标坐标（世界坐标，服务端校验）
 * @returns 是否放置成功
 */
export function placeEntity(
  world: GameWorld,
  playerEid: EntityId,
  slot: number,
  x: number,
  y: number,
): boolean {
  const result = planPlacement(world, playerEid, slot, x, y);
  if (!result.plan || result.reason !== undefined) return false;
  const plan = result.plan;
  const { stack, archetype, cell } = plan;

  // 消耗 1 个（kit 未必有 consume 效果，直接扣减堆叠）
  stack.count -= 1;
  if (stack.count <= 0) {
    const inv = Inventory[playerEid];
    if (inv) inv.slots[slot] = null;
  }

  const eid = spawnEntity(world, archetype, world.components_registry as ComponentRegistry, {
    x: plan.targetX,
    y: plan.targetY,
    mapId: plan.placerMap,
    level: plan.placedLevel,
  });

  // 所有权 + 格组写入（仅目标 archetype 声明了对应组件时写，防序列化污染）
  if (archetype.components["Placeable"]) {
    Placeable.ownerNetworkId[eid] = NetworkId.value[playerEid];
  }
  if (cell && archetype.components["GridOccupancy"]) {
    GridOccupancy.cellX[eid] = cell.cellX;
    GridOccupancy.cellY[eid] = cell.cellY;
    GridOccupancy.cellLevel[eid] = plan.placedLevel;
    GridOccupancy.cellW[eid] = cell.cellW;
    GridOccupancy.cellH[eid] = cell.cellH;
  }

  // 连接器角色：连接范围按放置层派生（上行 L↔L+1；下行 L-1↔L）——
  // 覆写原型声明的绝对层号（玩家放置时以放置者所在层为准）
  if (plan.role === STRUCTURE_ROLE_CONNECTOR) {
    const dir = plan.structure?.connectDir ?? CONNECTOR_DIR_UP;
    Structure.role[eid] = STRUCTURE_ROLE_CONNECTOR;
    Structure.connectDir[eid] = dir;
    Structure.connectLow[eid] = dir === CONNECTOR_DIR_UP ? plan.placedLevel : plan.placedLevel - 1;
    Structure.connectHigh[eid] = dir === CONNECTOR_DIR_UP ? plan.placedLevel + 1 : plan.placedLevel;
  }

  // 楼板改变按层碰撞静态体（地形 OR 建造）→ 递增建造纪元
  if (plan.role === STRUCTURE_ROLE_FLOOR) {
    bumpBuiltStructuresEpoch(world, plan.placerMap);
  }

  return true;
}
