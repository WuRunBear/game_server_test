/**
 * Inventory 组件：实体背包（AoS 结构）。
 *
 * 由 spawn 的 AoS 初始化钩子写入 `Inventory[eid]`，按 archetype 的
 * `components.Inventory` 配置（`{ capacity: number }`）建槽位数组。
 * 未声明 Inventory 的实体，`Inventory[eid]` 保持 undefined。
 *
 * 槽位存「item kind 字符串 + 堆叠数」而非物品实体 eid——item 是数据（item kind），
 * 不是长生命周期实体；堆叠/合并由 inventoryOps 在服务端权威完成。
 */
export interface ItemStack {
  /** item kind 字符串（引用 game/items/*.json 的 kind）。 */
  kind: string;
  /** 槽内数量。 */
  count: number;
}

export interface InventoryEntry {
  /** 容量上限（槽位数）。 */
  capacity: number;
  /** 槽位数组；空槽为 null。 */
  slots: (ItemStack | null)[];
}

export const Inventory = [] as (InventoryEntry | undefined)[];

/** Inventory archetype 配置形态。 */
interface InventoryConfig {
  capacity?: number;
}

const DEFAULT_CAPACITY = 4;

/** AoS 初始化钩子：按 archetype 配置建空槽位数组。 */
export function initInventory(
  _world: unknown,
  eid: number,
  config: unknown,
): void {
  const cfg = (config ?? {}) as InventoryConfig;
  const capacity = typeof cfg.capacity === "number" && cfg.capacity > 0 ? cfg.capacity : DEFAULT_CAPACITY;
  Inventory[eid] = {
    capacity,
    slots: Array.from({ length: capacity }, () => null),
  };
}