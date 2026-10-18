import { hasComponent, query } from "bitecs";
import {
  Resource,
  ResourceNode,
  Needs,
  Inventory,
  Equipment,
  Transform,
  entityMapOf,
  type ResourceNodeState,
  type LootEntry,
} from "components";
import type { GameWorld } from "world";
import { addToInventory, spawnDroppedItem, DROP_PICKUP_AFTER_MS } from "framework/systems/gameplay/inventoryOps";
import { getEquipModifiers } from "framework/systems/gameplay/equipmentSystem";
import { wearEquippedItem } from "framework/systems/gameplay/durability";
import { rngFrom } from "framework/simulation/rng";
import { applyEffectSpecs } from "framework/simulation/effects/effectRegistry";
import { EntityLevel } from "framework/components/entityLevel";
import { walkableAtLevel } from "map/geometry/query";
import { collectBuiltStructures } from "framework/map/runtime/builtStructures";
import {
  StateMachine,
  FSM_SIGNAL_HARVESTED,
  FSM_SIGNAL_DEPLETED,
} from "framework/simulation/stateMachine/stateMachine";
import { signalStateMachine } from "framework/simulation/stateMachine/stateMachineSystem";
import type { ConsumeEffect } from "framework/config/schema/ItemKindSchema";

/**
 * gatheringSystem：资源节点再生扫描 + harvest 采集原子。
 *
 * - 系统体：扫所有 [Resource] 实体，枯竭节点 regenMs 后回满。
 * - harvest：被 interactionSystem 路由调用（玩家对资源节点交互意图）。
 *
 * 游戏无关——不识别具体游戏名词，按 yieldsKind / lootTable 的 item kind 字符串
 * 查 item kind 表；工具门槛按 toolType 字符串相等比对（值由 game/ 配置定义）。
 */

/** 一次采集解析出的一种产物（kind + 本次数量，已乘采集倍率）。 */
interface HarvestProduct {
  kind: string;
  count: number;
}

/** 采集者 tool 装备槽中物品声明的 toolType（无工具/空槽/未声明 → undefined）。 */
function equippedToolType(world: GameWorld, actorEid: number): string | undefined {
  if (!hasComponent(world, actorEid, Equipment)) return undefined;
  const inv = Inventory[actorEid];
  if (!inv) return undefined;
  const ref = Equipment.toolSlot[actorEid];
  if (typeof ref !== "number" || ref < 0 || ref >= inv.slots.length) return undefined;
  const stack = inv.slots[ref];
  if (!stack) return undefined;
  return world.gameDef.itemsByKind?.get(stack.kind)?.toolType;
}

/**
 * 节点工具门槛是否满足。无 requiredToolType = 无门槛（历史行为零回归）。
 *
 * interactionSystem 路由时也调用此判定跳过不可采集节点：采集仍是权威校验点，
 * 路由跳过只为避免「最近的节点采不了」挡住其他可采节点。
 */
export function hasRequiredTool(world: GameWorld, actorEid: number, nodeEid: number): boolean {
  const state = ResourceNode[nodeEid];
  if (!state) return false;
  const required = state.requiredToolType;
  if (!required) return true;
  return equippedToolType(world, actorEid) === required;
}

/**
 * 解析本次采集产物。
 *
 * - 配置 lootTable：按条目顺序掷骰（命中 = next() < chance）；qty 为基础量，
 *   再乘 gatherMult 取整。随机流按 (tick, 采集者 eid, 节点 eid, "harvest")
 *   派生——同 tick/实体组合重复运行结果一致。
 * - 未配置：回退单产物 yieldsKind × amountPerHit × gatherMult（历史行为）。
 */
function rollHarvestProducts(
  world: GameWorld,
  actorEid: number,
  nodeEid: number,
  state: ResourceNodeState,
  gatherMult: number,
): HarvestProduct[] {
  const table: LootEntry[] | undefined = state.lootTable;
  if (!table || table.length === 0) {
    const count = Math.round(state.amountPerHit * gatherMult);
    return count > 0 ? [{ kind: state.yieldsKind, count }] : [];
  }

  const rng = rngFrom(world.time.tick, actorEid, nodeEid, "harvest");
  const products: HarvestProduct[] = [];
  for (const entry of table) {
    if (!(rng.next() < entry.chance)) continue;
    const count = Math.round(entry.qty * gatherMult);
    if (count > 0) products.push({ kind: entry.kind, count });
  }
  return products;
}

/** 溢出掉落小幅散布半径（px）：4~12px，明显小于丢弃物的 16~24px。 */
const HARVEST_DROP_SCATTER_MIN_PX = 4;
const HARVEST_DROP_SCATTER_RANGE_PX = 8;

/** 溢出掉落落点（像素 + 地图 key）。 */
export interface HarvestDropPoint {
  x: number;
  y: number;
  mapId: string;
}

/**
 * 采集溢出（背包部分容纳后剩余）的掉落落点（确定性，F-19）。
 *
 * 锚点取**资源节点**：剩余产物是节点本轮产出的一部分，落在节点附近比落在
 * 采集者脚下更符合语义，且不受采集者随后移动影响（节点无 Transform 时退回
 * 采集者）。
 *
 * 散布流 = rngFrom(tick, actorEid, nodeEid, "harvest-drop", productKey)：同
 * (tick, 玩家, 节点, 产物) 恒同落点；半径 4~12px（小幅，避免像丢弃物那样
 * 飞出交互半径）。落点格按采集者层视角经 walkableAtLevel（地形 OR 同层
 * 楼板，built 索引与碰撞/层号系统同源）校验；不可走时依次回退节点格中心、
 * 采集者格中心（同图时）、锚点周围 4 格内最近可走格——不落到地图原点。
 *
 * @param world 游戏世界
 * @param actorEid 采集者实体
 * @param nodeEid 资源节点实体
 * @param productKey 产物 kind（同节点多产物溢出时各占不同散布流，避免完全重叠）
 * @returns 掉落像素坐标与所属地图 key
 */
export function harvestDropPosition(
  world: GameWorld,
  actorEid: number,
  nodeEid: number,
  productKey = "",
): HarvestDropPoint {
  const actorHasTransform = hasComponent(world, actorEid, Transform);
  const nodeHasTransform = hasComponent(world, nodeEid, Transform);
  if (!actorHasTransform && !nodeHasTransform) {
    return { x: 0, y: 0, mapId: entityMapOf(world, actorEid) };
  }

  const anchorEid = nodeHasTransform ? nodeEid : actorEid;
  const anchorX = Transform.x[anchorEid];
  const anchorY = Transform.y[anchorEid];
  const mapId = entityMapOf(world, anchorEid);
  const level = EntityLevel[anchorEid] ?? EntityLevel[actorEid] ?? 0;
  const geometry = world.maps[mapId];
  if (!geometry) return { x: anchorX, y: anchorY, mapId };

  const { width, height, tileWidth, tileHeight } = geometry.grid;
  const built = collectBuiltStructures(world, mapId);
  const walkableAtPx = (px: number, py: number, atLevel: number): boolean => {
    const tx = Math.floor(px / tileWidth);
    const ty = Math.floor(py / tileHeight);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return false;
    return walkableAtLevel(geometry, tx, ty, atLevel, built);
  };
  /** 像素所在格的格中心（回退落点：与节点/采集者同格但不重叠）。 */
  const tileCenter = (px: number, py: number): { x: number; y: number } => ({
    x: (Math.floor(px / tileWidth) + 0.5) * tileWidth,
    y: (Math.floor(py / tileHeight) + 0.5) * tileHeight,
  });

  const rng = rngFrom(world.time.tick, actorEid, nodeEid, "harvest-drop", productKey);
  const angle = rng.next() * Math.PI * 2;
  const dist = HARVEST_DROP_SCATTER_MIN_PX + rng.next() * HARVEST_DROP_SCATTER_RANGE_PX;
  const dropX = anchorX + Math.cos(angle) * dist;
  const dropY = anchorY + Math.sin(angle) * dist;
  if (walkableAtPx(dropX, dropY, level)) return { x: dropX, y: dropY, mapId };

  // 回退 1：节点（锚点）所在格中心
  if (walkableAtPx(anchorX, anchorY, level)) {
    const center = tileCenter(anchorX, anchorY);
    return { ...center, mapId };
  }
  // 回退 2：采集者所在格中心（须同图）
  if (actorHasTransform && entityMapOf(world, actorEid) === mapId) {
    const actorX = Transform.x[actorEid];
    const actorY = Transform.y[actorEid];
    const actorLevel = EntityLevel[actorEid] ?? level;
    if (walkableAtPx(actorX, actorY, actorLevel)) {
      const center = tileCenter(actorX, actorY);
      return { ...center, mapId };
    }
  }
  // 回退 3：锚点周围 4 格内最近可走格（节点本身在不可走格、采集者也非可走时）
  const anchorTx = Math.floor(anchorX / tileWidth);
  const anchorTy = Math.floor(anchorY / tileHeight);
  for (let radius = 1; radius <= 4; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const tx = anchorTx + dx;
        const ty = anchorTy + dy;
        if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
        if (!walkableAtLevel(geometry, tx, ty, level, built)) continue;
        return { x: (tx + 0.5) * tileWidth, y: (ty + 0.5) * tileHeight, mapId };
      }
    }
  }
  // 最后兜底：节点原坐标（至少不再是地图原点）
  return { x: anchorX, y: anchorY, mapId };
}

/** 对资源节点采集一次。返回是否成功（成功才扣 remaining）。 */
export function harvest(world: GameWorld, actorEid: number, nodeEid: number): boolean {
  const nodeState = ResourceNode[nodeEid];
  if (!nodeState || nodeState.remaining <= 0) return false;

  // 工具门槛：与产出效率（gatherMult）正交——门槛只决定能否采，倍率只放大产出
  if (!hasRequiredTool(world, actorEid, nodeEid)) return false;

  const itemKinds = world.gameDef.itemsByKind;
  const hasTable = Array.isArray(nodeState.lootTable) && nodeState.lootTable.length > 0;
  // 单产物回退路径保持历史语义：产物 kind 未注册 → 拒绝且不动节点
  if (!hasTable && !itemKinds?.get(nodeState.yieldsKind)) return false;

  const gatherMult = getEquipModifiers(world, actorEid).gatherMult;
  const products = rollHarvestProducts(world, actorEid, nodeEid, nodeState, gatherMult);
  // 单产物路径的倍率取整为 0：不动节点（含 directConsume，历史行为）
  if (!hasTable && products.length === 0) return false;

  let applied = 0;
  for (const product of products) {
    const item = itemKinds?.get(product.kind);
    if (!item) {
      // 掉落表里的未知 kind 属配置缺陷：跳过该条目（不阻断其余产物）
      world.logger.warn("resource node loot entry kind is not registered; entry skipped", {
        nodeEid,
        kind: product.kind,
      });
      continue;
    }

    if (nodeState.directConsume) {
      // 直接施加 consume 效果（如直接饮用），不经过背包
      applyConsumeEffects(world, actorEid, item.consume, product.count);
      // 附加效果引用（目标 = 采集者）：如直接饮用带状态/定时副作用
      if (item.effects && item.effects.length > 0) {
        applyEffectSpecs(world, actorEid, [actorEid], item.effects);
      }
      applied += 1;
      continue;
    }

    const inv = Inventory[actorEid];
    if (!inv) continue; // 采集者无背包 → 该产物无法入包
    const leftover = addToInventory(inv, itemKinds, product.kind, product.count, {
      nowTick: world.time.tick,
    });
    const added = product.count - leftover;
    if (added <= 0) continue; // 满包：该产物一点未入
    applied += 1;
    if (leftover > 0) {
      // 部分入：剩余落到地上，避免丢失——落在资源节点附近（F-19），
      // 落点经可走性校验且确定性散布，绝不再落到地图原点 (0,0)。
      const drop = harvestDropPosition(world, actorEid, nodeEid, product.kind);
      spawnDroppedItem(
        world,
        { kind: product.kind, count: leftover },
        drop.x,
        drop.y,
        world.time.tick * world.time.fixedDtMs + DROP_PICKUP_AFTER_MS,
        drop.mapId,
        nodeEid,
        { scatter: false },
      );
    }
  }

  // 掉落表全部未命中 = 采集动作成立但本轮无产出（节点照常消耗一次）；
  // 命中了却一点也没落地（满包/未知 kind）= 拒绝，不动节点（历史满包语义）。
  if (products.length > 0 && applied === 0) return false;

  nodeState.remaining -= 1;
  if (nodeState.remaining <= 0) {
    nodeState.remaining = 0;
    nodeState.depletedSinceMs = world.time.tick * world.time.fixedDtMs;
  }

  // 工具磨损：仅手持（tool 槽）且声明 maxDurability 的工具；采集动作成立即耗一次。
  // directConsume 节点（直接饮用/食用）不经过工具产出，不计磨损。
  // 破碎后装备引用立即归 -1，下一次采集会被工具门槛拒绝（hasRequiredTool）。
  if (!nodeState.directConsume) {
    wearEquippedItem(world, actorEid, "tool");
  }

  // 通用状态机联动（可选）：资源状态变化作为即时信号广播给该实体的状态机。
  // 框架不解释信号语义——具体迁移由 game/ 配置按同名 `on` 声明。
  if (StateMachine[nodeEid]) {
    signalStateMachine(world, nodeEid, FSM_SIGNAL_HARVESTED);
    if (nodeState.remaining <= 0) {
      signalStateMachine(world, nodeEid, FSM_SIGNAL_DEPLETED);
    }
  }
  return true;
}

/** 采集消耗副作用：把 N 份 item.consume 效果施加到 actor 的 Needs（按 name 匹配）。 */
function applyConsumeEffects(
  world: GameWorld,
  actorEid: number,
  effects: readonly ConsumeEffect[] | undefined,
  multiplier: number,
): void {
  if (!effects || effects.length === 0) return;
  const needs = Needs[actorEid];
  if (!needs) return;
  for (const effect of effects) {
    const need = needs.find((n) => n.name === effect.need);
    if (need) {
      need.current = Math.min(need.max, need.current + effect.amount * multiplier);
    }
  }
}

export function gatheringSystem(world: GameWorld): GameWorld {
  const now = world.time.tick * world.time.fixedDtMs;

  // 资源节点再生扫
  for (const eid of query(world, [Resource])) {
    const state = ResourceNode[eid] as ResourceNodeState | undefined;
    if (!state) continue;
    if (state.remaining <= 0 && state.regenMs > 0 && state.depletedSinceMs !== null) {
      if (now - state.depletedSinceMs >= state.regenMs) {
        state.remaining = state.max;
        state.depletedSinceMs = null;
      }
    }
  }

  return world;
}