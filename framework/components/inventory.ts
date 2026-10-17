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
  /**
   * 整堆最早腐烂到期 tick（世界逻辑 tick）：同 kind 堆叠合并时取最早值。
   * 由 kind 的 spoilTicks 在入包时写入；缺省 = 不腐烂（或旧存档待系统补齐）。
   * 服务端权威，不参与 Inventory 的 netSync 字段（客户端可据 kind 推断）。
   */
  spoilAt?: number;
  /**
   * 当前耐久（逐实例状态）：入包时由 kind.maxDurability 初始化，装备使用磨损。
   * 仅 maxDurability 物品（加载期要求 maxStack 1，故无堆叠合并歧义）携带；
   * 缺省 = 无耐久（历史行为）或旧存档待首次磨损时按 kind 补齐。
   * 服务端权威，不参与 Inventory 的 netSync 字段（客户端可据 kind 推断上限）。
   */
  durability?: number;
}

export interface InventoryEntry {
  /** 容量上限（槽位数）。 */
  capacity: number;
  /** 槽位数组；空槽为 null。 */
  slots: (ItemStack | null)[];
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const Inventory = [] as (InventoryEntry | undefined)[];

/** Inventory archetype 配置形态。 */
interface InventoryConfig {
  capacity?: number;
}

/** 默认槽位数（配置未给出 capacity 时使用）。 */
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