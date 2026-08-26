/**
 * Inventory 操作原子（服务端权威，纯函数 + 薄封装）。
 *
 * 客户端 UI 通过命令通道调这些原子；服务端校验并变更数据/状态。
 * 不在此处理网络/输入——上层 GameSimulation 翻译 sessionId→eid 后调用本模块。
 *
 * 字段名（kind/need/name 等）保持游戏无关。
 */
import { hasComponent } from "bitecs";
import type { GameWorld } from "world";
import { Inventory, ItemMeta, Needs, type InventoryEntry, type ItemStack } from "components";
import { EntityMap, Item, Transform, entityMapOf } from "components";
import { spawnEntity } from "framework/entities/spawn";
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
    now + 1000,
    entityMapOf(world, ownerEid),
  );
  inv.slots[slot] = null;
  return true;
}

/** 生成一个地面 item 实体并写 ItemMeta（供 drop 与 loot 共用）。 */
export function spawnDroppedItem(
  world: GameWorld,
  stack: ItemStack,
  x: number,
  y: number,
  pickupAfterMs: number,
  mapId: string,
): number {
  const archetypeRegistry = world.archetypes as ArchetypeRegistry;
  const componentRegistry = world.components_registry as ComponentRegistry;
  const archetype = archetypeRegistry.get("item");

  // 随机偏移到 16~24px，避免与丢弃者重叠导致瞬捡回
  const angle = Math.random() * Math.PI * 2;
  const dist = 16 + Math.random() * 8;
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