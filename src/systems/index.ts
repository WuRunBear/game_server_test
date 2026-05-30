import type { System } from "src/world";

import { collisionSystem } from "systems/core/collisionSystem";
import { movementSystem } from "systems/core/movementSystem";
import { physicsSystem } from "systems/core/physicsSystem";
import { aiSystem } from "systems/gameplay/aiSystem";
import { npcWanderSystem } from "systems/gameplay/npcWanderSystem";
import { combatSystem } from "systems/gameplay/combatSystem";
import { interactionSystem } from "systems/gameplay/interactionSystem";
import { inventorySystem } from "systems/gameplay/inventorySystem";

/**
 * 按执行顺序组装系统列表。
 */
export function createSystems(): System[] {
  return [
    aiSystem,
    npcWanderSystem,
    physicsSystem,
    movementSystem,
    collisionSystem,
    combatSystem,
    inventorySystem,
    interactionSystem,
  ];
}

export {
  aiSystem,
  npcWanderSystem,
  physicsSystem,
  movementSystem,
  collisionSystem,
  combatSystem,
  inventorySystem,
  interactionSystem,
};
