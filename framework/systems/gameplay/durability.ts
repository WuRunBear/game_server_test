/**
 * 物品耐久磨损（游戏无关，数值全由 item kind 配置声明）。
 *
 * 语义：
 * - `maxDurability`：物品最大耐久；入包时初始化 ItemStack.durability（见 inventoryOps）。
 * - `wearPerUse`：每次「使用」磨损点数（缺省 1）。
 * - 磨损只作用于**装备槽引用**的物品（Equipment → Inventory 槽位）；背包内未装备
 *   的工具不耗耐久。
 *
 * 使用点：
 * - 采集成功一次 → tool 槽（gatheringSystem.harvest）
 * - 攻击命中一次 → weapon 槽（combatSystem.attackTarget）
 * - 受击一次 → armor 槽（combatSystem.attackTarget 的目标侧）
 *
 * 耐久 ≤ 0 → 物品破碎：清空背包槽位、立即把装备引用归 -1（equipmentSystem 的
 * tick 卫生是第二道保险），记日志并经类型化事件总线入队 `on-item-break`。
 */
import { hasComponent } from "bitecs";
import { Equipment, Inventory } from "components";
import type { GameWorld } from "world";
import { queueEvent } from "framework/simulation/events/eventBus";

/** 可磨损的装备槽名（与 Equipment 三槽及 EquipEffect.slot 对应）。 */
export type WearSlot = "weapon" | "tool" | "armor";

/** 槽名 → Equipment 字段引用表（读取与清理共用）。 */
const SLOT_FIELDS: Record<WearSlot, typeof Equipment.weaponSlot> = {
  weapon: Equipment.weaponSlot,
  tool: Equipment.toolSlot,
  armor: Equipment.armorSlot,
};

/**
 * 对装备槽中的物品施加一次使用磨损。
 *
 * @param world 游戏世界
 * @param ownerEid 装备持有者
 * @param slot 装备槽名
 * @returns 本次磨损是否导致物品破碎（无装备 / 无耐久物品 → false）
 */
export function wearEquippedItem(world: GameWorld, ownerEid: number, slot: WearSlot): boolean {
  if (!hasComponent(world, ownerEid, Equipment)) return false;
  const inv = Inventory[ownerEid];
  if (!inv) return false;

  const field = SLOT_FIELDS[slot];
  const ref = field[ownerEid];
  if (typeof ref !== "number" || ref < 0 || ref >= inv.slots.length) return false;

  const stack = inv.slots[ref];
  if (!stack) return false;

  const spec = world.gameDef.itemsByKind?.get(stack.kind);
  const maxDurability = spec?.maxDurability;
  // 无耐久物品（或槽位物品与槽类型不符，属过期引用）不磨损
  if (maxDurability === undefined || maxDurability <= 0) return false;
  if (spec?.equip?.slot !== slot) return false;

  // 旧存档 / 手工写入的堆叠没有 durability：从首次磨损起按上限补齐
  const current = stack.durability ?? maxDurability;
  const wear = spec?.wearPerUse ?? 1;
  const next = current - wear;

  if (next > 0) {
    stack.durability = next;
    return false;
  }

  // 破碎：清槽 + 立即清装备引用（netSync 的 Equipment 字段不广播过期 ref）
  inv.slots[ref] = null;
  field[ownerEid] = -1;
  world.logger.info("equipped item broke (durability depleted)", {
    eid: ownerEid,
    kind: stack.kind,
    slot,
    maxDurability,
  });
  queueEvent(world, "on-item-break", { eid: ownerEid, kind: stack.kind, slot });
  return true;
}
