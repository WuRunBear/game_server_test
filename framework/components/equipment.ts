import { defineComponent, Types } from "bitecs/legacy";

/**
 * Equipment 组件：实体装备槽（SoA 结构）。
 *
 * 三个槽分别引用 Inventory 的槽位索引（-1 表示未穿戴）。
 * 具体加成数值不存于此——由 item kind 的 equip 配置声明，
 * 读取方（combat/gathering）经 getEquipModifiers 按槽引用解析。
 *
 * 槽位引用可能因库存变更（drop/transfer/consume）过期；
 * equipmentSystem 的 tick 体负责把指向空槽的引用归 -1（同步诚实），
 * 读取方本身对过期引用自愈（解析不到合法物品即视为无加成）。
 */
export const Equipment = defineComponent({
  /** 武器槽：引用 Inventory 槽位索引，-1 未穿戴。 */
  weaponSlot: Types.i32,
  /** 工具槽：引用 Inventory 槽位索引，-1 未穿戴。 */
  toolSlot: Types.i32,
  /** 护甲槽：引用 Inventory 槽位索引，-1 未穿戴。 */
  armorSlot: Types.i32,
});
