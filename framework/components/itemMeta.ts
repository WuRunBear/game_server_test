/**
 * ItemMeta 组件：地面 item 实体的元数据（AoS 结构）。
 *
 * item 是「数据种类的产物」，地面实体只是为了在世界里占位/可见，故轻量化：
 * 记录 kind（item kind 字符串）、count（堆叠数）、pickupAfterMs（Earliest
 * 可被自动拾取的逻辑时间戳，解决「丢下即被拾回」）。
 *
 * 由 dropSlot / loot 等生成 item 实体时写入，不由 archetype 声明（无 initializer）。
 * inventorySystem 拾取时读此结构与背包合并。
 */
export interface ItemMetaEntry {
  kind: string;
  count: number;
  /** 当前逻辑时间（tick × fixedDtMs）小于此值时不可自动拾取。 */
  pickupAfterMs: number;
}

export const ItemMeta = [] as (ItemMetaEntry | undefined)[];