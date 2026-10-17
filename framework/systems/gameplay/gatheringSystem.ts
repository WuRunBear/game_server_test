import { hasComponent, query } from "bitecs";
import {
  Resource,
  ResourceNode,
  Needs,
  Inventory,
  Equipment,
  entityMapOf,
  type ResourceNodeState,
  type LootEntry,
} from "components";
import type { GameWorld } from "world";
import { addToInventory, spawnDroppedItem, DROP_PICKUP_AFTER_MS } from "framework/systems/gameplay/inventoryOps";
import { getEquipModifiers } from "framework/systems/gameplay/equipmentSystem";
import { rngFrom } from "framework/simulation/rng";
import { applyEffectSpecs } from "framework/simulation/effects/effectRegistry";
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
      // 部分入：剩余落到地上，避免丢失
      spawnDroppedItem(
        world,
        { kind: product.kind, count: leftover },
        0,
        0,
        world.time.tick * world.time.fixedDtMs + DROP_PICKUP_AFTER_MS,
        entityMapOf(world, actorEid),
        actorEid,
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