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
  /**
   * 绝对腐烂到期 tick（世界逻辑 tick）：由 kind 的 spoilTicks 在生成掉落物时写入，
   * 拾取/丢弃时随堆叠继承。缺省 = 该物品不腐烂（或旧存档待系统按 kind 补齐）。
   * 服务端权威，不参与 netSync 载荷（客户端可据 kind 推断）。
   */
  spoilAt?: number;
  /**
   * 当前耐久（逐实例状态）：丢弃时从背包槽继承、拾取时回写背包槽，
   * 避免「丢下再捡起」重置耐久。缺省 = 无耐久（或旧存档待按 kind 补齐）。
   * 服务端权威，不参与 netSync 载荷（客户端可据 kind 推断上限）。
   */
  durability?: number;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const ItemMeta = [] as (ItemMetaEntry | undefined)[];