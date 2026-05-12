import type { System } from "src/world";

import { collisionSystem } from "systems/core/collisionSystem";
import { movementSystem } from "systems/core/movementSystem";
import { physicsSystem } from "systems/core/physicsSystem";
import { combatSystem } from "systems/gameplay/combatSystem";
import { interactionSystem } from "systems/gameplay/interactionSystem";
import { inventorySystem } from "systems/gameplay/inventorySystem";
import { broadcastSystem } from "systems/network/broadcastSystem";
import { snapshotSystem } from "systems/network/snapshotSystem";

/**
 * 按执行顺序组装系统列表。
 */
export function createSystems(): System[] {
  return [
    physicsSystem,
    movementSystem,
    collisionSystem,
    combatSystem,
    inventorySystem,
    interactionSystem,
    snapshotSystem,
    broadcastSystem,
  ];
}

export {
  physicsSystem,
  movementSystem,
  collisionSystem,
  combatSystem,
  inventorySystem,
  interactionSystem,
  snapshotSystem,
  broadcastSystem,
};
