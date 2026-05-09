import type { System } from "../world";

import { collisionSystem } from "./core/collisionSystem";
import { movementSystem } from "./core/movementSystem";
import { physicsSystem } from "./core/physicsSystem";
import { combatSystem } from "./gameplay/combatSystem";
import { interactionSystem } from "./gameplay/interactionSystem";
import { inventorySystem } from "./gameplay/inventorySystem";
import { broadcastSystem } from "./network/broadcastSystem";
import { snapshotSystem } from "./network/snapshotSystem";

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
