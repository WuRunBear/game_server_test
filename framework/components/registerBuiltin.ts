/**
 * 内置组件注册表装配。
 *
 * 把 framework 内置的 SoA/Tag 组件与 AoS 初始化钩子统一注册进组件注册表，
 * 由 bootstrapFramework 调用；组件名即 game/ 配置 entities/*.json 中
 * components 块的键。游戏无关——这里只注册通用组件，不含任何游戏语义。
 */
import type { ComponentRegistry } from "framework/components/componentRegistry";
import { Transform } from "framework/components/transform";
import { Size } from "framework/components/size";
import { Velocity, Acceleration, Collider, ColliderShape } from "framework/components/physics";
import { Health, Attack, Defense, Team } from "framework/components/combat";
import { AIState, Target, BlackboardRef } from "framework/components/ai";
import { Inventory, initInventory } from "framework/components/inventory";
import { ItemMeta } from "framework/components/itemMeta";
import { EntityMap } from "framework/components/entityMap";
import { Needs, initNeeds } from "framework/components/needs";
import { ResourceNode, initResourceNode } from "framework/components/resourceNode";
import { LootTable, initLootTable } from "framework/components/loot";
import { Perception } from "framework/components/perception";
import { Equipment } from "framework/components/equipment";
import { CraftingStation } from "framework/components/craftingStation";
import { LightSource } from "framework/components/lightSource";
import { Placeable } from "framework/components/placeable";
import { GridOccupancy } from "framework/components/gridOccupancy";
import { Portal, initPortal } from "framework/components/portal";
import { Dialogue } from "framework/components/dialogue";
import { DialogueSource, initDialogueSource } from "framework/components/dialogueSource";
import { Quest } from "framework/components/quest";
import { Relation } from "framework/components/relation";
import { Intent } from "framework/components/intent";
import { NetworkId, LastSynced } from "framework/components/network";
import { Cooldown, Duration } from "framework/components/timer";
import { Player, Enemy, NPC, Item, Resource } from "framework/components/tags";
import { Kind } from "framework/components/kind";

/**
 * 注册全部内置组件及其 AoS 初始化钩子。
 * 供 bootstrap 在启动时调用一次（注册表按组件名去重，重复注册会抛错）。
 */
export function registerBuiltinComponents(registry: ComponentRegistry): void {
  // 空间/运动/碰撞
  registry.register("Transform", Transform);
  registry.register("Size", Size);
  registry.register("Velocity", Velocity);
  registry.register("Acceleration", Acceleration);
  registry.register("Collider", Collider);
  // 战斗
  registry.register("Health", Health);
  registry.register("Attack", Attack);
  registry.register("Defense", Defense);
  registry.register("Team", Team);
  // AI 状态/目标/黑板引用
  registry.register("AIState", AIState);
  registry.register("Target", Target);
  registry.register("BlackboardRef", BlackboardRef);
  // 物品/背包（AoS）
  registry.register("Inventory", Inventory);
  registry.register("ItemMeta", ItemMeta);
  // 需求/资源/掉落（AoS）
  registry.register("Needs", Needs);
  registry.register("ResourceNode", ResourceNode);
  registry.register("LootTable", LootTable);
  // 感知
  registry.register("Perception", Perception);
  // 装备/合成/光源/放置/网格占用
  registry.register("Equipment", Equipment);
  registry.register("CraftingStation", CraftingStation);
  registry.register("LightSource", LightSource);
  registry.register("Placeable", Placeable);
  registry.register("GridOccupancy", GridOccupancy);
  // 传送/对话/任务/好感/意图（AoS）
  registry.register("Portal", Portal);
  registry.register("Dialogue", Dialogue);
  registry.register("DialogueSource", DialogueSource);
  registry.register("Quest", Quest);
  registry.register("Relation", Relation);
  registry.register("Intent", Intent);
  // 地图分区（AoS）：实体所属地图标识，无条目回退 world.defaultMapId
  registry.register("EntityMap", EntityMap);
  // 网络同步
  registry.register("NetworkId", NetworkId);
  registry.register("LastSynced", LastSynced);
  registry.register("Cooldown", Cooldown);
  registry.register("Duration", Duration);
  // 标签（bitecs 空组件）
  registry.register("Player", Player);
  registry.register("Enemy", Enemy);
  registry.register("NPC", NPC);
  registry.register("Item", Item);
  registry.register("Resource", Resource);
  // 种类标签（AoS）
  registry.register("Kind", Kind);

  // AoS 组件初始化钩子
  registry.registerAosInitializer("Inventory", initInventory);
  registry.registerAosInitializer("Needs", initNeeds);
  registry.registerAosInitializer("ResourceNode", initResourceNode);
  registry.registerAosInitializer("LootTable", initLootTable);
  registry.registerAosInitializer("Portal", initPortal);
  registry.registerAosInitializer("DialogueSource", initDialogueSource);
}
