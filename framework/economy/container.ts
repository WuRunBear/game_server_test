/**
 * 统一容器层——跨容器类型（背包槽位 / 计数账本）的数量操作原语。
 *
 * 两种容器实现：
 * - "inventory"：包装现有 InventoryEntry（槽位堆叠模型），insert 复用
 *   inventoryOps.addToInventory 的堆叠合并规则（maxStack 语义，itemKinds 查表），
 *   remove 为跨槽扣减，query 为跨槽统计；
 * - "ledger"：Ledger AoS 组件（kind → 数量记账，无容量上限），insert 直加、
 *   remove 校验余额后直减（归零移除键）。
 *
 * 转移原语 transfer/swap 遵循「先全量校验后执行、失败整体回滚」的原子性：
 * 以容器快照（结构化克隆）为回滚依据，任何一步失败即恢复快照，零副作用。
 *
 * 游戏无关——kind 为通用物品种类字符串，具体语义由 game/items 配置约定。
 */
import type { GameWorld } from "framework/world";
import { Inventory, type InventoryEntry } from "framework/components/inventory";
import { Ledger, type LedgerRecord } from "framework/components/ledger";
import { addToInventory } from "framework/systems/gameplay/inventoryOps";

/** 容器种类（与 PlayerCommand 交易条款的 container 字段一致）。 */
export type ContainerKind = "inventory" | "ledger";

/** 容器引用：种类 + 实体 eid。 */
export interface ContainerRef {
  type: ContainerKind;
  eid: number;
}

/* ------------------------------------------------------------------ */
/* 内部工具：按种类取容器数据                                           */
/* ------------------------------------------------------------------ */

/** 取背包容器数据（无该组件数据时 undefined）。 */
function inventoryOf(ref: ContainerRef): InventoryEntry | undefined {
  if (ref.type !== "inventory") return undefined;
  return Inventory[ref.eid];
}

/** 取账本容器数据；create 为 true 时缺失则建空账本（credit 语义自建）。 */
function ledgerOf(ref: ContainerRef, create: boolean): LedgerRecord | undefined {
  if (ref.type !== "ledger") return undefined;
  let record = Ledger[ref.eid];
  if (!record && create) {
    record = Ledger[ref.eid] = {};
  }
  return record;
}

/** 背包跨槽贪婪扣减 kind（调用前已校验数量足够，必然扣足）。 */
function removeFromInventory(inv: InventoryEntry, kind: string, count: number): void {
  let remaining = count;
  for (let i = 0; i < inv.slots.length && remaining > 0; i++) {
    const slot = inv.slots[i];
    if (!slot || slot.kind !== kind) continue;
    const take = Math.min(remaining, slot.count);
    slot.count -= take;
    remaining -= take;
    if (slot.count <= 0) inv.slots[i] = null;
  }
}

/* ------------------------------------------------------------------ */
/* 基础原语：query / insert / remove                                   */
/* ------------------------------------------------------------------ */

/**
 * 查询容器中 kind 的数量。
 * @returns 数量；容器不存在时 0
 */
export function queryContainer(world: GameWorld, ref: ContainerRef, kind: string): number {
  const inv = inventoryOf(ref);
  if (inv) {
    let total = 0;
    for (const slot of inv.slots) {
      if (slot && slot.kind === kind) total += slot.count;
    }
    return total;
  }
  const record = ledgerOf(ref, false);
  return record ? (record[kind] ?? 0) : 0;
}

/**
 * 向容器插入 count 个 kind。
 * @returns 未容纳的剩余量（满包/无容器时全部剩余；账本无容量恒为 0）
 */
export function insertContainer(world: GameWorld, ref: ContainerRef, kind: string, count: number): number {
  if (count <= 0) return 0;
  const inv = inventoryOf(ref);
  if (inv) {
    return addToInventory(inv, world.gameDef.itemsByKind, kind, count);
  }
  const record = ledgerOf(ref, true);
  if (record) {
    record[kind] = (record[kind] ?? 0) + count;
    return 0;
  }
  return count;
}

/**
 * 从容器扣减 count 个 kind（原子：余额不足时整体拒绝、零副作用）。
 * @returns 是否扣减成功
 */
export function removeContainer(world: GameWorld, ref: ContainerRef, kind: string, count: number): boolean {
  if (count <= 0) return false;
  const inv = inventoryOf(ref);
  if (inv) {
    if (queryContainer(world, ref, kind) < count) return false;
    removeFromInventory(inv, kind, count);
    return true;
  }
  const record = ledgerOf(ref, false);
  if (!record) return false;
  const balance = record[kind] ?? 0;
  if (balance < count) return false;
  if (balance - count <= 0) {
    delete record[kind];
  } else {
    record[kind] = balance - count;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 快照 / 回滚（原子性依据；settle 复用同一原语）                        */
/* ------------------------------------------------------------------ */

/** 容器快照公开类型（inventory 槽位结构克隆 / ledger 记账表克隆 / undefined）。 */
export type ContainerSnapshot = InventoryEntry | LedgerRecord | undefined;

/** 对容器做结构化快照（inventory 克隆槽位结构，ledger 浅拷贝记账表）。 */
export function snapshotContainer(ref: ContainerRef): ContainerSnapshot {
  const inv = inventoryOf(ref);
  if (inv) {
    return {
      capacity: inv.capacity,
      slots: inv.slots.map((slot) => (slot ? { kind: slot.kind, count: slot.count } : null)),
    };
  }
  const record = ledgerOf(ref, false);
  return record ? { ...record } : undefined;
}

/** 按快照恢复容器（快照为 undefined 时清除该容器条目）。 */
export function restoreContainer(ref: ContainerRef, snapshot: ContainerSnapshot): void {
  if (ref.type === "inventory") {
    Inventory[ref.eid] = snapshot as InventoryEntry | undefined;
  } else {
    Ledger[ref.eid] = snapshot as LedgerRecord | undefined;
  }
}

/* ------------------------------------------------------------------ */
/* 转移原语：transfer / swap（先全量校验后执行，失败整体回滚）            */
/* ------------------------------------------------------------------ */

/** 判断两个容器引用是否相同（同实体同种类）。 */
function sameRef(a: ContainerRef, b: ContainerRef): boolean {
  return a.type === b.type && a.eid === b.eid;
}

/**
 * 跨容器转移 count 个 kind。
 *
 * 原子性：先校验源足量，再对目标做快照 + 试插入（容量校验），任一步失败
 * 即恢复目标快照并返回 false；全部通过后才扣减源（校验已过，必然成功）。
 * 同一容器引用转移返回 false（无转移意义）。
 *
 * @returns 是否转移成功（失败零副作用）
 */
export function transferContainer(
  world: GameWorld,
  src: ContainerRef,
  dst: ContainerRef,
  kind: string,
  count: number,
): boolean {
  if (!(count > 0) || sameRef(src, dst)) return false;

  // 1) 源足量校验
  if (queryContainer(world, src, kind) < count) return false;

  // 2) 目标容量校验：快照 → 试插入 → 剩余即失败
  const dstSnapshot = snapshotContainer(dst);
  const leftover = insertContainer(world, dst, kind, count);
  if (leftover > 0) {
    restoreContainer(dst, dstSnapshot);
    return false;
  }

  // 3) 源扣减（第 1 步已校验，必然成功）
  return removeContainer(world, src, kind, count);
}

/** 收集容器全部内容（kind → 数量合并，供 swap 交叉转移）。 */
function collectContents(world: GameWorld, ref: ContainerRef): Map<string, number> {
  const contents = new Map<string, number>();
  const inv = inventoryOf(ref);
  if (inv) {
    for (const slot of inv.slots) {
      if (!slot) continue;
      contents.set(slot.kind, (contents.get(slot.kind) ?? 0) + slot.count);
    }
    return contents;
  }
  const record = ledgerOf(ref, false);
  if (record) {
    for (const [kind, count] of Object.entries(record)) {
      if (count > 0) contents.set(kind, (contents.get(kind) ?? 0) + count);
    }
  }
  return contents;
}

/** 清空容器内容（不销毁容器本身：背包保留容量，账本保留存在性）。 */
function clearContainer(world: GameWorld, ref: ContainerRef): void {
  const inv = inventoryOf(ref);
  if (inv) {
    inv.slots.fill(null);
    return;
  }
  const record = ledgerOf(ref, false);
  if (record) {
    for (const key of Object.keys(record)) delete record[key];
  }
}

/**
 * 交换两个容器的全部内容。
 *
 * 原子性：对双方做快照 → 清空 → 交叉插入对方内容；任一侧出现剩余
 * （容量不足）即整体回滚双方快照并返回 false。
 *
 * @returns 是否交换成功（失败零副作用）
 */
export function swapContainers(world: GameWorld, a: ContainerRef, b: ContainerRef): boolean {
  if (sameRef(a, b)) return false;

  const snapshotA = snapshotContainer(a);
  const snapshotB = snapshotContainer(b);
  const contentsA = collectContents(world, a);
  const contentsB = collectContents(world, b);

  clearContainer(world, a);
  clearContainer(world, b);

  let leftover = 0;
  for (const [kind, count] of contentsA) leftover += insertContainer(world, b, kind, count);
  for (const [kind, count] of contentsB) leftover += insertContainer(world, a, kind, count);

  if (leftover > 0) {
    restoreContainer(a, snapshotA);
    restoreContainer(b, snapshotB);
    return false;
  }
  return true;
}
