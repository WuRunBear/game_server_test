import type { ComponentRegistry } from "framework/components/componentRegistry";
import { Transform } from "framework/components/transform";
import { Size } from "framework/components/size";
import { Velocity, Acceleration, Collider, ColliderShape } from "framework/components/physics";
import { Health, Attack, Defense, Team } from "framework/components/combat";
import { AIState, Target, BlackboardRef } from "framework/components/ai";
import { Inventory } from "framework/components/inventory";
import { NetworkId, LastSynced } from "framework/components/network";
import { Cooldown, Duration } from "framework/components/timer";
import { Player, Enemy, NPC, Item } from "framework/components/tags";
import { Kind } from "framework/components/kind";

export function registerBuiltinComponents(registry: ComponentRegistry): void {
  registry.register("Transform", Transform);
  registry.register("Size", Size);
  registry.register("Velocity", Velocity);
  registry.register("Acceleration", Acceleration);
  registry.register("Collider", Collider);
  registry.register("Health", Health);
  registry.register("Attack", Attack);
  registry.register("Defense", Defense);
  registry.register("Team", Team);
  registry.register("AIState", AIState);
  registry.register("Target", Target);
  registry.register("BlackboardRef", BlackboardRef);
  registry.register("Inventory", Inventory);
  registry.register("NetworkId", NetworkId);
  registry.register("LastSynced", LastSynced);
  registry.register("Cooldown", Cooldown);
  registry.register("Duration", Duration);
  registry.register("Player", Player);
  registry.register("Enemy", Enemy);
  registry.register("NPC", NPC);
  registry.register("Item", Item);
  registry.register("Kind", Kind);
}
