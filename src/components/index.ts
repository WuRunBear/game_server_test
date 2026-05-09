/**
 * 组件统一导出入口。
 *
 * 约定：
 * - 组件用 SoA（对象里放数组）或 AoS（数组里放对象）的形式表达
 * - Tag 组件使用空对象表示
 */
export { Transform } from "./transform";
export { Velocity, Acceleration, Collider } from "./physics";
export { Health, Attack, Defense, Team } from "./combat";
export { AIState, BlackboardRef, Target } from "./ai";
export { Inventory, type InventorySlots } from "./inventory";
export { NetworkId, LastSynced } from "./network";
export { Cooldown, Duration } from "./timer";
export { Player, Enemy, NPC, Item } from "./tags";
