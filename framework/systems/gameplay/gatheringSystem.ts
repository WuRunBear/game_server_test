import { query } from "bitecs";
import { Resource, ResourceNode, Needs, Inventory, type ResourceNodeState } from "components";
import type { GameWorld } from "world";
import { addToInventory, spawnDroppedItem } from "framework/systems/gameplay/inventoryOps";
import type { ConsumeEffect } from "framework/config/schema/ItemKindSchema";

/**
 * gatheringSystem：资源节点再生扫描 + harvest 采集原子。
 *
 * - 系统体：扫所有 [Resource] 实体，枯竭节点 regenMs 后回满。
 * - harvest：被 interactionSystem 路由调用（玩家对资源节点交互意图）。
 *
 * 游戏无关——不识别具体游戏名词，按 yieldsKind 字符串查 item kind 表。
 */

/** 对资源节点采集一次。返回是否成功（成功才扣 remaining）。 */
export function harvest(world: GameWorld, actorEid: number, nodeEid: number): boolean {
  const nodeState = ResourceNode[nodeEid];
  if (!nodeState || nodeState.remaining <= 0) return false;

  const itemKinds = world.gameDef.itemsByKind;
  const item = itemKinds?.get(nodeState.yieldsKind);
  if (!item) return false;

  const amount = nodeState.amountPerHit;

  if (nodeState.directConsume) {
    // 直接施加 consume 效果（如直接饮用），不经过背包
    applyConsumeEffects(world, actorEid, item.consume, amount);
  } else {
    const inv = Inventory[actorEid];
    if (!inv) return false; // 采集者无背包 → 拒
    const leftover = addToInventory(inv, itemKinds, nodeState.yieldsKind, amount);
    const added = amount - leftover;
    if (added <= 0) return false; // 满包 → 不动节点
    if (leftover > 0) {
      // 部分入：剩余落到地上，避免丢失
      spawnDroppedItem(
        world,
        { kind: nodeState.yieldsKind, count: leftover },
        0,
        0,
        world.time.tick * world.time.fixedDtMs + 1000,
      );
    }
  }

  nodeState.remaining -= 1;
  if (nodeState.remaining <= 0) {
    nodeState.remaining = 0;
    nodeState.depletedSinceMs = world.time.tick * world.time.fixedDtMs;
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