import { hasComponent, query } from "bitecs";
import { Equipment, Inventory } from "components";
import type { GameWorld } from "world";
import type { EquipEffect, ItemKindSpec } from "framework/config/schema/ItemKindSchema";
import { STAT_GATHER_MULT } from "framework/simulation/modifiers/modifiers";
import { getSkillMultiplier } from "framework/systems/gameplay/progression";
import { DEFAULT_CRIT_MULTIPLIER } from "framework/systems/gameplay/damageFormula";

/**
 * equipmentSystem：装备穿戴原子 + 加成读取 + 槽位引用卫生。
 *
 * - `equipSlot`：服务端权威穿戴原子（客户端命令通道调用），
 *   校验槽内有物品且该 item 声明了 equip 效果，按效果槽位写入 Equipment 引用。
 * - `getEquipModifiers`：按三槽引用解析当前加成——combat/gathering 的 on-read
 *   修正点；对过期引用自愈（槽空 / 物品无对应槽位效果 → 视为无加成）。
 *   `gatherMult` 额外乘成长系统按 statKey=gatherMult 配置的技能加成（采集系统
 *   只经此入口读倍率）；attack/defense 的技能加成由 combat 显式组合，避免
 *   同一加成在两条读取路径重复计算。
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

/**
 * 解析实体某装备槽当前生效的 item kind（槽空 / 引用过期 / 物品与该槽类型
 * 不匹配 → undefined，读取方自愈）。combat 的暴击/伤害类型与 resist 读取
 * 复用同一解析路径。
 */
function equippedItemKind(
  world: GameWorld,
  eid: number,
  slot: EquipEffect["slot"],
): ItemKindSpec | undefined {  const inv = Inventory[eid];
  if (!inv) return undefined;
  const field =
    slot === "weapon" ? Equipment.weaponSlot : slot === "tool" ? Equipment.toolSlot : Equipment.armorSlot;
  const ref = field[eid];
  if (typeof ref !== "number" || ref < 0 || ref >= inv.slots.length) return undefined;
  const stack = inv.slots[ref];
  if (!stack) return undefined;
  const item = world.gameDef.itemsByKind?.get(stack.kind);
  if (!item?.equip || item.equip.slot !== slot) return undefined;
  return item;
}

/**
 * 公开的装备槽物品解析（同上内部规则的导出形态）：供投射物投掷等需要读取
 * 装备物品配置（而非仅数值加成）的框架机制复用，避免重复实现槽位自愈。
 */
export function getEquippedItemKind(
  world: GameWorld,
  eid: number,
  slot: EquipEffect["slot"],
): ItemKindSpec | undefined {
  return equippedItemKind(world, eid, slot);
}

/** 攻击方 weapon 槽物品提供的暴击 / 伤害类型档案（无武器时全缺省）。 */
export interface WeaponCombatProfile {
  /** 暴击概率（0 = 不暴击）。 */
  critChance: number;
  /** 暴击倍率（critChance > 0 时有效；未配置取缺省 1.5）。 */
  critMultiplier: number;
  /** 伤害类型（缺省 = 不参与克制匹配）。 */
  damageType?: string;
}

/** 读攻击方 weapon 的暴击/伤害类型配置；无武器或未配置时为零值。 */
export function getWeaponCombatProfile(world: GameWorld, eid: number): WeaponCombatProfile {
  const item = equippedItemKind(world, eid, "weapon");
  if (!item) return { critChance: 0, critMultiplier: 1 };
  const critChance =
    typeof item.critChance === "number" && Number.isFinite(item.critChance) && item.critChance > 0
      ? Math.min(1, item.critChance)
      : 0;
  return {
    critChance,
    critMultiplier:
      critChance > 0
        ? typeof item.critMultiplier === "number" && Number.isFinite(item.critMultiplier)
          ? Math.max(1, item.critMultiplier)
          : DEFAULT_CRIT_MULTIPLIER
        : 1,
    damageType:
      typeof item.damageType === "string" && item.damageType.length > 0
        ? item.damageType
        : undefined,
  };
}

/**
 * 读防御方 armor 对指定伤害类型的原始抗性（未配置/无护甲/类型不匹配 → 0）。
 * 钳制由 damageFormula.clampDamageResist 统一负责。
 */
export function getArmorDamageResist(
  world: GameWorld,
  eid: number,
  damageType: string | undefined,
): number {
  if (!damageType) return 0;
  const item = equippedItemKind(world, eid, "armor");
  const resist = item?.resist?.[damageType];
  return typeof resist === "number" && Number.isFinite(resist) ? resist : 0;
}

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
 * - 采集倍率再乘成长系统的技能加成（statKey = gatherMult；无技能时恒 1）
 */
export function getEquipModifiers(world: GameWorld, eid: number): EquipModifiers {
  const inv = Inventory[eid];
  if (!inv) return EMPTY_MODIFIERS();

  const out: EquipModifiers = { attackBonus: 0, defenseBonus: 0, gatherMult: 1 };

  for (const entry of SLOT_FIELDS) {
    const effect = equippedItemKind(world, eid, entry.slot)?.equip;
    if (!effect) continue;

    if (entry.slot === "weapon") out.attackBonus += effect.attackBonus ?? 0;
    else if (entry.slot === "armor") out.defenseBonus += effect.defenseBonus ?? 0;
    else if (entry.slot === "tool") out.gatherMult *= effect.gatherMult ?? 1;
  }

  // 技能加成与工具倍率是乘法叠加（工具决定基础产出效率，技能按配置放大）
  out.gatherMult *= getSkillMultiplier(world, eid, STAT_GATHER_MULT);

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
