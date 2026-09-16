/**
 * Ledger 组件：实体计数账本（AoS 结构）。
 *
 * 按实体记录「kind 字符串 → 数量」的键值表，用作无槽位上限的计数容器
 * （与 Inventory 的槽位堆叠模型互补）；典型用途是各类计数型资源记账，
 * 具体语义由 game/ 配置约定，本组件不含任何游戏专属含义。
 *
 * 由容器层（framework/economy/container.ts）经统一容器接口读写；
 * 随实体入档持久化（worldSerializer AoS 分支自动覆盖，不在瞬态清单）；
 * 网络同步经 aosSyncAdapters 的 Ledger 适配器按 kind 展平。
 */

/** 账本数据形态：kind → 数量（数量归零时移除键，避免空条目膨胀）。 */
export type LedgerRecord = Record<string, number>;

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const Ledger = [] as (LedgerRecord | undefined)[];

/** Ledger archetype 配置形态。 */
interface LedgerConfig {
  /** 初始条目（可选；缺省空账本）。 */
  entries?: Record<string, number>;
}

/** AoS 初始化钩子：按 archetype 配置建账本（浅拷贝配置条目，防共享引用）。 */
export function initLedger(
  _world: unknown,
  eid: number,
  config: unknown,
): void {
  const cfg = (config ?? {}) as LedgerConfig;
  Ledger[eid] = { ...(cfg.entries ?? {}) };
}
