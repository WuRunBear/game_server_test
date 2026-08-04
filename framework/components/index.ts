/**
 * 组件统一导出入口。
 *
 * 约定：
 * - 组件用 SoA（对象里放数组）或 AoS（数组里放对象）的形式表达
 * - Tag 组件使用 bitecs 的空组件表示
 */
export { Transform } from "components/transform";
export { Size } from "components/size";
export { Velocity, Acceleration, Collider, ColliderShape } from "components/physics";
export { Health, Attack, Defense, Team } from "components/combat";
export { AIState, BlackboardRef, Target } from "components/ai";
export { Inventory, initInventory, type ItemStack, type InventoryEntry } from "components/inventory";
export { ItemMeta, type ItemMetaEntry } from "components/itemMeta";
export { NetworkId, LastSynced } from "components/network";
export { Cooldown, Duration } from "components/timer";
export { Player, Enemy, NPC, Item, Resource } from "components/tags";
export { Needs, initNeeds, type Need } from "components/needs";
export { ResourceNode, initResourceNode, type ResourceNodeState } from "components/resourceNode";
export { LootTable, initLootTable, type LootEntry } from "components/loot";
export { Perception } from "components/perception";
export { Equipment } from "components/equipment";
export { CraftingStation } from "components/craftingStation";
export { Intent } from "components/intent";
export { Kind } from "components/kind";
