/**
 * LootTable 组件：实体死亡时的掉落表（AoS 结构）。
 *
 * 每个条目 `{kind, qty, chance}`：
 * - kind：item kind 字符串（与 ItemMeta / Inventory 同款引用）
 * - qty：命中时的掉落数量
 * - chance：0~1 的命中概率
 *
 * 由 deathSystem 在实体死亡时逐条掷骰，产出地面 item 实体。
 * 纯服务端数据（客户端不需要概率表），故不注册 netSync 适配器。
 */
export interface LootEntry {
  /** item kind 字符串。 */
  kind: string;
  /** 命中时的掉落数量。 */
  qty: number;
  /** 命中概率（0~1）。 */
  chance: number;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const LootTable = [] as (LootEntry[] | undefined)[];

/** AoS 初始化钩子：深拷贝 archetype 的 LootTable 数组配置。 */
export function initLootTable(_world: unknown, eid: number, config: unknown): void {
  const arr = Array.isArray(config) ? (config as LootEntry[]) : [];
  LootTable[eid] = arr.map((e) => ({
    kind: String(e?.kind ?? ""),
    qty: Number(e?.qty ?? 1),
    chance: Number(e?.chance ?? 1),
  }));
}
