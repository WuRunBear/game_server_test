import type { SystemRegistry } from "framework/systems/systemRegistry";
import type { ActionRegistry } from "framework/ai/actionRegistry";
import type { GameWorld } from "framework/world";

import { physicsSystem } from "framework/systems/core/physicsSystem";
import { movementSystem } from "framework/systems/core/movementSystem";
import { collisionSystem } from "framework/systems/core/collisionSystem";
import { aiSystem } from "framework/systems/gameplay/aiSystem";
import { createCombatSystem } from "framework/systems/gameplay/combatSystem";
import { inventorySystem } from "framework/systems/gameplay/inventorySystem";
import { interactionSystem } from "framework/systems/gameplay/interactionSystem";
import { spawningSystem } from "framework/systems/gameplay/spawningSystem";

import { setDefaultActionRegistry } from "framework/ai/btFactory";
import { registerBuiltinActions } from "framework/ai/registerBuiltinActions";

export function registerBuiltinSystems(
  systemRegistry: SystemRegistry,
  actionRegistry: ActionRegistry,
): void {
  registerBuiltinActions(actionRegistry);
  setDefaultActionRegistry(actionRegistry);

  systemRegistry.register({
    id: "ai",
    factory: (_world: GameWorld) => aiSystem,
    defaultOrder: 10,
  });

  systemRegistry.register({
    id: "physics",
    factory: (_world: GameWorld) => physicsSystem,
    after: ["ai"],
  });

  systemRegistry.register({
    id: "movement",
    factory: (_world: GameWorld) => movementSystem,
    after: ["physics"],
  });

  systemRegistry.register({
    id: "collision",
    factory: (_world: GameWorld) => collisionSystem,
    after: ["movement"],
  });

  systemRegistry.register({
    id: "combat",
    factory: (_world: GameWorld, config?: Record<string, unknown>) => createCombatSystem(config),
    after: ["collision"],
  });

  systemRegistry.register({
    id: "spawning",
    factory: (_world: GameWorld) => spawningSystem,
    after: ["combat"],
  });

  systemRegistry.register({
    id: "inventory",
    factory: (_world: GameWorld) => inventorySystem,
    after: ["spawning"],
  });

  systemRegistry.register({
    id: "interaction",
    factory: (_world: GameWorld) => interactionSystem,
    after: ["inventory"],
  });
}
