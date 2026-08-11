import { hasComponent, query } from "bitecs";
import { Equipment, Inventory } from "components";
import type { GameWorld } from "world";
import type { EquipEffect } from "framework/config/schema/ItemKindSchema";

/**
 * equipmentSystem：装备穿戴原子 + 加成读取 + 槽位引用卫生。
 *
 * - `equipSlot`：服务端权威穿戴原子（客户端命令通道调用），
 *   校验槽内有物品且该 item 声明了 equip 效果，按效果槽位写入 Equipment 引用。
 * - `getEquipModifiers`：按三槽引用解析当前加成——combat/gathering 的 on-read
 *   修正点；对过期引用自愈（槽空 / 物品无对应槽位效果 → 视为无加成）。
 * - 系统 tick 体：把指向空槽的引用归 -1（保证 netSync 的 Equipment 字段诚实）。
 *
 * 游戏无关——槽位词（weapon/tool/armor）与数值加成都是通用机制词，
 * 具体物品的加成数值由 game/items 的 equip 配置声明。
 */

export interface EquipModifiers {
  attackBonus: number;
  defenseBonus: number;
  gatherMult: number;
}

/** 无装备时的零值加成（tool 槽缺省倍率为 1，即不放大采集产出）。 */
const EMPTY_MODIFIERS = (): EquipModifiers => ({ attackBonus: 0, defenseBonus: 0, gatherMult: 1 });

const SLOT_FIELDS: { name: "weaponSlot" | "toolSlot" | "armorSlot"; slot: EquipEffect["slot"]; field: typeof Equipment.weaponSlot }[] = [
  { name: "weaponSlot", slot: "weapon", field: Equipment.weaponSlot },
  { name: "toolSlot", slot: "tool", field: Equipment.toolSlot },
  { name: "armorSlot", slot: "armor", field: Equipment.armorSlot },
];

/** 穿戴原子：把 owner 背包 slotIdx 处的物品穿到对应装备槽。 */
export function equipSlot(world: GameWorld, ownerEid: number, slotIdx: number): boolean {
  const inv = Inventory[ownerEid];
  if (!inv) return false;
  const stack = inv.slots[slotIdx];
  if (!stack) return false;

  const effect = world.gameDef.itemsByKind?.get(stack.kind)?.equip;
  if (!effect) return false;
  if (!hasComponent(world, ownerEid, Equipment)) return false;

  const target = SLOT_FIELDS.find((s) => s.slot === effect.slot);
  if (!target) return false;
  target.field[ownerEid] = slotIdx;
  return true;
}

/**
 * 读取实体当前装备加成。
 *
 * 按三槽引用解析 Inventory 槽位；解析规则：
 * - 引用为 -1、槽已空、或槽内物品的 equip.slot 与该槽类型不符 → 该槽无加成（自愈）
 * - weapon/armor 累加数值加成；tool 乘法累积采集倍率
 */
export function getEquipModifiers(world: GameWorld, eid: number): EquipModifiers {
  const inv = Inventory[eid];
  if (!inv) return EMPTY_MODIFIERS();
  const itemsByKind = world.gameDef.itemsByKind;

  const out: EquipModifiers = { attackBonus: 0, defenseBonus: 0, gatherMult: 1 };

  for (const entry of SLOT_FIELDS) {
    const ref = entry.field[eid];
    if (typeof ref !== "number" || ref < 0 || ref >= inv.slots.length) continue;
    const stack = inv.slots[ref];
    if (!stack) continue;
    const effect = itemsByKind?.get(stack.kind)?.equip;
    if (!effect || effect.slot !== entry.slot) continue;

    if (entry.slot === "weapon") out.attackBonus += effect.attackBonus ?? 0;
    else if (entry.slot === "armor") out.defenseBonus += effect.defenseBonus ?? 0;
    else if (entry.slot === "tool") out.gatherMult *= effect.gatherMult ?? 1;
  }

  return out;
}

/**
 * 槽位卫生：装备引用指向的槽为空，或槽内物品已不再匹配该槽类型 → 归 -1。
 * 与 getEquipModifiers 的读取规则对齐——否则 transfer 换物后引用残留，
 * 物品换回时加成会未经 equip 命令静默恢复，且 netSync 持续广播过期 ref。
 */
export function equipmentSystem(world: GameWorld): GameWorld {
  const itemsByKind = world.gameDef.itemsByKind;
  for (const eid of query(world, [Equipment])) {
    const inv = Inventory[eid];
    if (!inv) continue;
    for (const entry of SLOT_FIELDS) {
      const ref = entry.field[eid];
      if (typeof ref !== "number" || ref < 0) continue;
      const stack = inv.slots[ref];
      const effect = stack ? itemsByKind?.get(stack.kind)?.equip : undefined;
      if (!stack || effect?.slot !== entry.slot) {
        entry.field[eid] = -1;
      }
    }
  }
  return world;
}
