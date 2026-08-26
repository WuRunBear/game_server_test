/**
 * 组件统一导出入口。
 *
 * 约定：
 * - 组件用 SoA（对象里放数组）或 AoS（数组里放对象）的形式表达
 * - Tag 组件使用 bitecs 的空组件表示
 */
// —— 空间/运动/碰撞 ——
export { Transform } from "components/transform";
export { Size } from "components/size";
export { Velocity, Acceleration, Collider, ColliderShape } from "components/physics";
// —— 战斗 ——
export { Health, Attack, Defense, Team } from "components/combat";
// —— AI ——
export { AIState, BlackboardRef, Target } from "components/ai";
// —— 物品/背包（AoS 数据组件） ——
export { Inventory, initInventory, type ItemStack, type InventoryEntry } from "components/inventory";
export { ItemMeta, type ItemMetaEntry } from "components/itemMeta";
// —— 网络同步 ——
export { NetworkId, LastSynced } from "components/network";
// —— 计时 ——
export { Cooldown, Duration } from "components/timer";
// —— 标签（bitecs 空组件） ——
export { Player, Enemy, NPC, Item, Resource } from "components/tags";
// —— 需求/资源/掉落（AoS 数据组件） ——
export { Needs, initNeeds, type Need } from "components/needs";
export { ResourceNode, initResourceNode, type ResourceNodeState } from "components/resourceNode";
export { LootTable, initLootTable, type LootEntry } from "components/loot";
// —— 感知 ——
export { Perception } from "components/perception";
// —— 装备/合成/光源/放置/网格占用 ——
export { Equipment } from "components/equipment";
export { CraftingStation } from "components/craftingStation";
export { LightSource } from "components/lightSource";
export { Placeable } from "components/placeable";
export { GridOccupancy } from "components/gridOccupancy";
// —— 传送门/对话/任务/好感/意图/种类（AoS 数据组件） ——
export { Portal, initPortal, type PortalState } from "components/portal";
export { Dialogue, type DialogueState } from "components/dialogue";
export { DialogueSource, initDialogueSource, type DialogueSourceState } from "components/dialogueSource";
export { Quest, QUEST_AVAILABLE, QUEST_ACTIVE, QUEST_READY, QUEST_DONE, type QuestState } from "components/quest";
export { Relation, type RelationState } from "components/relation";
export { Intent } from "components/intent";
export { Kind } from "components/kind";
// —— 地图分区（AoS） ——
export { EntityMap, entityMapOf } from "components/entityMap";
