/**
 * Kind 组件：实体的原型种类标签（AoS 结构）。
 *
 * - 存储 archetype.kind 字符串，供需要按种类过滤的系统读取（如演化引擎的规则计数）。
 * - 与 Inventory 同为 AoS（普通 JS 数组按 eid 索引）：kind 是字符串，无法用 SoA 数值数组表达，
 *   故沿用 Inventory 的 AoS 先例。访问方式：`Kind[eid]`。
 * - 由 spawnEntity → setEntityKind 写入；不在 archetype.components 中声明，
 *   也不参与 bitecs 的 query/addComponent（与 Inventory 一致）。
 */
/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const Kind = [] as string[];