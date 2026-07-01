/**
 * InventorySlots：实体背包槽位结构（AoS 结构的元素类型）。
 *
 * 约定：
 * - slot0~slot3 存放物品实体 eid（或物品 id，取决于系统实现）
 * - 空槽位通常为 0（以系统实现为准）
 */
export interface InventorySlots {
  /**
   * 槽位 0：物品实体 eid（或物品 id）。
   */
  slot0: number;
  /**
   * 槽位 1：物品实体 eid（或物品 id）。
   */
  slot1: number;
  /**
   * 槽位 2：物品实体 eid（或物品 id）。
   */
  slot2: number;
  /**
   * 槽位 3：物品实体 eid（或物品 id）。
   */
  slot3: number;
}

/**
 * Inventory 组件：实体背包（AoS 结构）。
 *
 * 约定：
 * - 通过 Inventory[eid] 访问该实体的槽位数据
 */
export const Inventory = [] as InventorySlots[];
