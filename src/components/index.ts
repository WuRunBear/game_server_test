/**
 * 组件统一导出入口。
 *
 * 约定：
 * - 组件用 SoA（对象里放数组）或 AoS（数组里放对象）的形式表达
 * - Tag 组件使用空对象表示
 */
export { Transform } from "components/transform";
export { Velocity, Acceleration, Collider } from "components/physics";
export { Health, Attack, Defense, Team } from "components/combat";
export { AIState, BlackboardRef, Target } from "components/ai";
export { Inventory, type InventorySlots } from "components/inventory";
export { NetworkId, LastSynced } from "components/network";
export { Cooldown, Duration } from "components/timer";
export { Player, Enemy, NPC, Item } from "components/tags";
