export { physicsSystem } from "framework/systems/core/physicsSystem";
export { movementSystem } from "framework/systems/core/movementSystem";
export { collisionSystem, getCollisionDebugSnapshot, type CollisionDebugSnapshot } from "framework/systems/core/collisionSystem";
export { aiSystem } from "framework/systems/gameplay/aiSystem";
export { combatSystem } from "framework/systems/gameplay/combatSystem";
export { inventorySystem } from "framework/systems/gameplay/inventorySystem";
export { interactionSystem } from "framework/systems/gameplay/interactionSystem";

import { aiSystem } from "framework/systems/gameplay/aiSystem";
import { physicsSystem } from "framework/systems/core/physicsSystem";
import { movementSystem } from "framework/systems/core/movementSystem";
import { collisionSystem } from "framework/systems/core/collisionSystem";
import { combatSystem } from "framework/systems/gameplay/combatSystem";
import { inventorySystem } from "framework/systems/gameplay/inventorySystem";
import { interactionSystem } from "framework/systems/gameplay/interactionSystem";
import type { System } from "framework/world";

export function createSystems(): System[] {
  return [
    aiSystem,
    physicsSystem,
    movementSystem,
    collisionSystem,
    combatSystem,
    inventorySystem,
    interactionSystem,
  ];
}
