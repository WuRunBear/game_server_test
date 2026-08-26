/**
 * 放置系统（原子模块，无 tick 体）。
 *
 * 客户端经 PlayerCommand `place` 调用 placeEntity；服务端校验并变更：
 * 物品 kind 声明 `place.archetype`（要放置成哪种实体）→ 校验占位尺寸来源
 * （Placeable 组件配置，回退 Size）→ 距离 / 实体重叠 / 地图阻挡校验（零副作用）
 * → 消耗 1 个该物品 → spawnEntity 目标 archetype。
 *
 * S6 扩展（建造闭环）：
 * - 网格对齐：rules/place.json 的 `gridSnap`（缺省 false 保持旧行为）开启时，
 *   占位矩形对齐地图网格（snapToGrid），最终坐标取对齐后格组中心
 * - 网格占用：对齐后写入 GridOccupancy（格组），放置校验加格组冲突判定
 *   （同格重放被拒）——墙/地板可无缝拼接，且不会叠放
 * - 所有权：spawn 后写 Placeable.ownerNetworkId（放置者 networkId），
 *   供 deconstruct（仅放置者可拆）判定；无主放置物（0）不可拆
 *
 * 校验全部在消耗之前完成：任一校验失败即拒绝，不留半成品状态。
 * 放置范围经 rules/place.json 的 placeRange 配置（缺省 64）。
 */
import { Transform, Inventory, NetworkId, Placeable, GridOccupancy, entityMapOf } from "components";
import { spawnEntity } from "framework/entities/spawn";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { ArchetypeRegistry, ArchetypeSpec } from "framework/entities/archetypeRegistry";
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
const FALLBACK_FOOTPRINT = 16;

/** 目标 archetype 的占位尺寸：Placeable 组件配置优先，回退 Size，再回退兜底值。 */
function footprintOf(archetype: ArchetypeSpec): { w: number; h: number } {
  const placeable = archetype.components["Placeable"] as
    | { footprintW?: number; footprintH?: number }
    | undefined;
  const size = archetype.components["Size"] as { w?: number; h?: number } | undefined;
  return {
    w: placeable?.footprintW ?? size?.w ?? FALLBACK_FOOTPRINT,
    h: placeable?.footprintH ?? size?.h ?? FALLBACK_FOOTPRINT,
  };
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
  const inv = Inventory[playerEid];
  if (!inv) return false;
  const stack = inv.slots[slot];
  if (!stack) return false;

  const item = world.gameDef.itemsByKind?.get(stack.kind);
  if (!item?.place) return false;

  const archetypeRegistry = world.archetypes as ArchetypeRegistry;
  if (!archetypeRegistry.has(item.place.archetype)) return false;
  const archetype = archetypeRegistry.get(item.place.archetype);
  if (!archetype) return false;

  const rules = world.gameDef.resolvedRules["place"] as PlaceRule | undefined;
  const range = rules?.placeRange ?? DEFAULT_PLACE_RANGE;
  const dist = Math.hypot(x - Transform.x[playerEid], y - Transform.y[playerEid]);
  if (dist > range) return false;

  const { w, h } = footprintOf(archetype);

  // 网格对齐（gridSnap 开启）：目标坐标取对齐后格组中心，并校验格组占用
  let targetX = x;
  let targetY = y;
  let cell: { cellX: number; cellY: number; cellW: number; cellH: number } | undefined;
  if (rules?.gridSnap) {
    const snapped = snapToGrid(world, x, y, w, h);
    targetX = snapped.x;
    targetY = snapped.y;
    if (snapped.cellW > 0 && snapped.cellH > 0) {
      cell = snapped;
      if (overlapsOccupiedGrid(world, snapped.cellX, snapped.cellY, snapped.cellW, snapped.cellH)) {
        return false;
      }
    }
  }

  if (overlapsAnyEntity(world, targetX, targetY, w, h)) return false;
  if (overlapsMapBlocked(world, targetX, targetY, w, h)) return false;

  // 消耗 1 个（kit 未必有 consume 效果，直接扣减堆叠）
  stack.count -= 1;
  if (stack.count <= 0) inv.slots[slot] = null;

  const eid = spawnEntity(world, archetype, world.components_registry as ComponentRegistry, {
    x: targetX,
    y: targetY,
    mapId: entityMapOf(world, playerEid),
  });

  // 所有权 + 格组写入（仅目标 archetype 声明了对应组件时写，防序列化污染）
  if (archetype.components["Placeable"]) {
    Placeable.ownerNetworkId[eid] = NetworkId.value[playerEid];
  }
  if (cell && archetype.components["GridOccupancy"]) {
    GridOccupancy.cellX[eid] = cell.cellX;
    GridOccupancy.cellY[eid] = cell.cellY;
    GridOccupancy.cellW[eid] = cell.cellW;
    GridOccupancy.cellH[eid] = cell.cellH;
  }
  return true;
}
