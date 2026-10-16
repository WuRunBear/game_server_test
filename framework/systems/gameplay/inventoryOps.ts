/**
 * Inventory 操作原子（服务端权威，纯函数 + 薄封装）。
 *
 * 客户端 UI 通过命令通道调这些原子；服务端校验并变更数据/状态。
 * 不在此处理网络/输入——上层 GameSimulation 翻译 sessionId→eid 后调用本模块。
 *
 * 字段名（kind/need/name 等）保持游戏无关。
 */
import { hasComponent, query } from "bitecs";
import type { GameWorld } from "world";
import { rngFrom } from "framework/simulation/rng";
import { Inventory, ItemMeta, Needs, NetworkId, type InventoryEntry, type ItemStack } from "components";
import { EntityMap, Item, Transform, entityMapOf } from "components";
import { spawnEntity } from "framework/entities/spawn";
import { applyEffectSpecs } from "framework/simulation/effects/effectRegistry";
import type { ArchetypeRegistry } from "framework/entities/archetypeRegistry";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { ItemKindSpec, ConsumeEffect } from "framework/config/schema/ItemKindSchema";

const DEFAULT_MAX_STACK = 1;

/** 物品最大堆叠数：itemKinds 查不到该 kind（或未声明 maxStack）时按 1。 */
function maxStackFor(itemKinds: Map<string, ItemKindSpec> | undefined, kind: string): number {
  return itemKinds?.get(kind)?.maxStack ?? DEFAULT_MAX_STACK;
}

/**
 * 把 count 个 kind 物品并入背包；可部分并入，返回未入背包的剩余量。
 * 规则：先合入同 kind 未满堆叠，再用空槽；满包则剩余返还。
 */
export function addToInventory(
  inv: InventoryEntry,
  itemKinds: Map<string, ItemKindSpec> | undefined,
  kind: string,
  count: number,
): number {
  let remaining = count;
  const maxStack = maxStackFor(itemKinds, kind);

  // 1) 合入同 kind 未满堆叠
  for (const slot of inv.slots) {
    if (remaining <= 0) break;
    if (slot && slot.kind === kind && slot.count < maxStack) {
      const add = Math.min(remaining, maxStack - slot.count);
      slot.count += add;
      remaining -= add;
    }
  }

  // 2) 用空槽
  for (let i = 0; i < inv.slots.length && remaining > 0; i++) {
    if (inv.slots[i] === null) {
      const add = Math.min(remaining, maxStack);
      inv.slots[i] = { kind, count: add };
      remaining -= add;
    }
  }

  return remaining;
}

/**
 * 转/合/换两个槽。空 from → no-op。
 *
 * 同 kind 合并时以 `maxStackFor(kind)` 决定上限（遵守 item 的 maxStack）；
 * 未提供查找函数或查不到该 kind 时，保守按 1 上限（dst 已满则原地交换）。
 */
export function transferSlot(
  inv: InventoryEntry,
  from: number,
  to: number,
  maxStackFor?: (kind: string) => number,
): boolean {
  if (from === to) return false;
  const src = inv.slots[from];
  if (!src) return false;
  const dst = inv.slots[to];

  if (!dst) {
    inv.slots[to] = src;
    inv.slots[from] = null;
    return true;
  }

  if (dst.kind === src.kind) {
    const maxStack = maxStackFor ? maxStackFor(src.kind) : DEFAULT_MAX_STACK;
    const space = maxStack - dst.count;
    const move = Math.min(src.count, space);
    if (move <= 0) {
      // 同 kind 但 dst 已满 → 原地交换（保持两者都可见）
      inv.slots[to] = src;
      inv.slots[from] = dst;
      return true;
    }
    dst.count += move;
    src.count -= move;
    if (src.count <= 0) inv.slots[from] = null;
    return true;
  }

  // 不同 kind 占用 → 交换
  inv.slots[to] = src;
  inv.slots[from] = dst;
  return true;
}

/** 食用：对持有者施加 item.consume 效果，消耗 1 个；不可食用返回 false。 */
export function consumeSlot(world: GameWorld, ownerEid: number, slot: number): boolean {
  const inv = inventoryOf(world, ownerEid);
  if (!inv) return false;
  const stack = inv.slots[slot];
  if (!stack) return false;

  const itemKinds = world.gameDef.itemsByKind;
  const item = itemKinds?.get(stack.kind);
  const effects = item?.consume;
  if (!effects || effects.length === 0) return false;

  const needs = Needs[ownerEid];
  if (needs) {
    for (const effect of effects) {
      const need = needs.find((n) => n.name === effect.need);
      if (need) {
        need.current = Math.min(need.max, need.current + effect.amount);
      }
    }
  }

  // 附加效果引用：目标 = 使用者（状态效果/定时效果等，经 effectRegistry 求值）
  if (item?.effects && item.effects.length > 0) {
    applyEffectSpecs(world, ownerEid, [ownerEid], item.effects);
  }

  stack.count -= 1;
  if (stack.count <= 0) inv.slots[slot] = null;
  return true;
}

/** 丢弃 slot：spawn "item" 实体并写 ItemMeta；清空槽。 */
export function dropSlot(world: GameWorld, ownerEid: number, slot: number): boolean {
  const inv = inventoryOf(world, ownerEid);
  if (!inv) return false;
  const stack = inv.slots[slot];
  if (!stack) return false;

  if (!hasComponent(world, ownerEid, Transform)) return false;

  const now = world.time.tick * world.time.fixedDtMs;
  spawnDroppedItem(
    world,
    stack,
    Transform.x[ownerEid],
    Transform.y[ownerEid],
    now + DROP_PICKUP_AFTER_MS,
    entityMapOf(world, ownerEid),
    ownerEid,
  );
  inv.slots[slot] = null;
  return true;
}

/** 丢弃/溢出物防瞬回延迟（ms）：掉落者就在旁边，给走开时间。 */
export const DROP_PICKUP_AFTER_MS = 1000;

/**
 * 从容器实体取回槽位物品到操作者背包（死亡容器/储物容器共用原语）。
 *
 * 经命令通道调用（transfer + target = 容器 networkId；transferSlot 是
 * 单背包内原子，跨容器转移由此原语承担）：目标须带 Inventory 且与操作者
 * 同图；整并入则清源槽，部分并入则回写剩余（满包不吞，容器侧零变更）。
 * 不做距离校验——与 consume/drop/transfer 同层级的命令原子，范围限制
 * 属交互层关注（与 deconstruct 的 placeRange 校验不同源，避免耦合规则）。
 *
 * @param world 游戏世界
 * @param playerEid 操作者实体
 * @param containerNetworkId 容器实体的稳定网络标识
 * @param slot 容器内的源槽索引
 * @returns 是否有物品被取回
 */
export function lootContainerSlot(
  world: GameWorld,
  playerEid: number,
  containerNetworkId: number,
  slot: number,
): boolean {
  if (!Number.isInteger(containerNetworkId) || containerNetworkId <= 0) return false;
  const playerInv = Inventory[playerEid];
  if (!playerInv) return false;

  // 按 networkId 查容器 eid（实体量小，线性查找即可，与 deconstruct 同模式）
  let containerEid: number | undefined;
  for (const eid of query(world, [NetworkId])) {
    if (NetworkId.value[eid] === containerNetworkId) {
      containerEid = eid;
      break;
    }
  }
  if (containerEid === undefined || containerEid === playerEid) return false;
  const containerInv = Inventory[containerEid];
  if (!containerInv) return false;

  // 同图校验：跨图取回拒绝（归属异常时双方同回退默认图，比较仍成立）
  if (entityMapOf(world, containerEid) !== entityMapOf(world, playerEid)) return false;

  const stack = containerInv.slots[slot];
  if (!stack) return false;

  const leftover = addToInventory(playerInv, world.gameDef.itemsByKind, stack.kind, stack.count);
  if (leftover >= stack.count) return false; // 满包：一点未入，容器侧零变更
  if (leftover > 0) {
    stack.count = leftover; // 部分并入：剩余留在容器
  } else {
    containerInv.slots[slot] = null; // 整槽取空
  }
  return true;
}

/** 生成一个地面 item 实体并写 ItemMeta（供 drop 与 loot 共用）。
 *
 * `sourceEid` 是丢弃/死亡来源实体，用于派生确定性散布流（tick + 来源 eid）；
 * 缺省用 -1（无来源调用）——同 tick 同来源的多次掉落共享同一条流，仍确定。
 */
export function spawnDroppedItem(
  world: GameWorld,
  stack: ItemStack,
  x: number,
  y: number,
  pickupAfterMs: number,
  mapId: string,
  sourceEid?: number,
): number {
  const archetypeRegistry = world.archetypes as ArchetypeRegistry;
  const componentRegistry = world.components_registry as ComponentRegistry;
  const archetype = archetypeRegistry.get("item");

  // 确定性地散布到 16~24px，避免与丢弃者重叠导致瞬捡回
  // （tick + 来源 eid 派生，同世界状态恒同落点）
  const rng = rngFrom(world.time.tick, sourceEid ?? -1, "drop");
  const angle = rng.next() * Math.PI * 2;
  const dist = 16 + rng.next() * 8;
  const eid = spawnEntity(world, archetype, componentRegistry, {
    x: x + Math.cos(angle) * dist,
    y: y + Math.sin(angle) * dist,
  });

  EntityMap[eid] = mapId;
  ItemMeta[eid] = { kind: stack.kind, count: stack.count, pickupAfterMs };
  return eid;
}

/** 取实体背包（无该组件数据时返回 undefined）。 */
function inventoryOf(world: GameWorld, eid: number): InventoryEntry | undefined {
  return Inventory[eid];
}