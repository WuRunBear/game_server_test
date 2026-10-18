/**
 * spoilSystem：通用物品腐烂（游戏无关，绝对 tick 驱动，确定性无随机）。
 *
 * 语义由 item kind 配置声明：
 * - `spoilTicks`：生成后经过多少 tick 腐烂（缺省/0 = 永不腐烂）；
 * - `spoilInto`：到期转换成的 item kind（缺省 = 直接消失）。
 *
 * 到期时刻用**绝对 tick** 记录，两处承载：
 * - 地面掉落物 → `ItemMeta.spoilAt`
 * - 背包/容器堆叠 → `ItemStack.spoilAt`（同 kind 且同 spoilAt 才合并；混批
 *   保持独立堆叠——F-22）
 * 绝对 tick 使读档与离线补差天然可继续腐烂（补差把 world.time.tick 推到边界后，
 * 下一次系统扫描即结算全部到期堆叠）。
 *
 * 检查节奏：每 tick 扫描（地面 Item 实体 + 全部 Inventory 槽位）。数据量小且
 * 无随机/无 I/O；不需要额外节流状态。
 */
import { query } from "bitecs";
import type { GameWorld } from "framework/world";
import { Inventory, Item, ItemMeta, type InventoryEntry } from "components";
import { destroyEntity } from "framework/entities/destroyEntity";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";

/** 该 kind 的腐烂时长；未声明/0 → undefined（永不腐烂）。 */
export function spoilTicksOf(
  itemKinds: Map<string, ItemKindSpec> | undefined,
  kind: string,
): number | undefined {
  const ticks = itemKinds?.get(kind)?.spoilTicks;
  return ticks !== undefined && ticks > 0 ? ticks : undefined;
}

/** 按 kind 配置把「现在 + spoilTicks」折算为绝对到期 tick；不腐烂返回 undefined。 */
export function spoilAtForTick(
  itemKinds: Map<string, ItemKindSpec> | undefined,
  kind: string,
  nowTick: number,
): number | undefined {
  const ticks = spoilTicksOf(itemKinds, kind);
  return ticks === undefined ? undefined : nowTick + ticks;
}

/** 合并两个到期时刻：取最早；任一侧缺省时取另一侧（都缺省 = undefined）。 */
export function mergeSpoilAt(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** 背包/容器堆叠到期结算：转换 kind（保留数量）或清空槽位。 */
function spoilInventorySlot(
  world: GameWorld,
  itemKinds: Map<string, ItemKindSpec> | undefined,
  inv: InventoryEntry,
  slotIndex: number,
  nowTick: number,
): void {
  const slot = inv.slots[slotIndex];
  if (!slot) return;

  const ticks = spoilTicksOf(itemKinds, slot.kind);
  if (ticks === undefined) return;

  // 旧存档/手工写入的堆叠没有 spoilAt：从首次可见时刻起算，下一次扫描再判定。
  if (slot.spoilAt === undefined) {
    slot.spoilAt = nowTick + ticks;
    return;
  }
  if (nowTick < slot.spoilAt) return;

  const spoilInto = itemKinds?.get(slot.kind)?.spoilInto;
  if (!spoilInto) {
    inv.slots[slotIndex] = null;
    return;
  }

  if (!itemKinds?.has(spoilInto)) {
    // 配置缺陷（加载期 validateIntegrity 已前置校验）；防御性按消失处理，避免
    // 产出未注册 kind 的物品。
    world.logger.warn("spoilInto references an unknown item kind; stack removed", {
      from: slot.kind,
      spoilInto,
    });
    inv.slots[slotIndex] = null;
    return;
  }

  // 保留数量（转换不拆分、不合并；目标 kind 的 maxStack 不在此处裁剪）
  slot.kind = spoilInto;
  slot.spoilAt = spoilAtForTick(itemKinds, spoilInto, nowTick);
}

/**
 * 每 tick 腐烂扫描：
 * - 地面 Item 实体：到期后改 ItemMeta.kind（保留 count）或销毁实体；
 * - 全部 Inventory 条目（玩家/容器/尸体）：按槽位绝对 tick 结算。
 */
export function spoilSystem(world: GameWorld): GameWorld {
  const itemKinds = world.gameDef.itemsByKind;
  const nowTick = world.time.tick;

  for (const eid of query(world, [Item])) {
    const meta = ItemMeta[eid];
    if (!meta) continue;

    const ticks = spoilTicksOf(itemKinds, meta.kind);
    if (ticks === undefined) continue;

    if (meta.spoilAt === undefined) {
      meta.spoilAt = nowTick + ticks;
      continue;
    }
    if (nowTick < meta.spoilAt) continue;

    const spoilInto = itemKinds?.get(meta.kind)?.spoilInto;
    if (!spoilInto) {
      destroyEntity(world, eid);
      continue;
    }

    if (!itemKinds?.has(spoilInto)) {
      world.logger.warn("spoilInto references an unknown item kind; ground item removed", {
        eid,
        from: meta.kind,
        spoilInto,
      });
      destroyEntity(world, eid);
      continue;
    }

    meta.kind = spoilInto;
    meta.spoilAt = spoilAtForTick(itemKinds, spoilInto, nowTick);
  }

  // Inventory 是 AoS（不可 query）：按 eid 索引线性扫描；destroyEntity 已清理
  // 残留条目，因此 undefined 即无背包。
  for (let eid = 0; eid < Inventory.length; eid++) {
    const inv = Inventory[eid];
    if (!inv) continue;
    for (let slot = 0; slot < inv.slots.length; slot++) {
      spoilInventorySlot(world, itemKinds, inv, slot, nowTick);
    }
  }

  return world;
}
