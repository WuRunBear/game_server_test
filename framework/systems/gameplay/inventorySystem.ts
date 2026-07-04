import { query } from "bitecs";
import { Inventory, Transform, Player, Item } from "components";
import { removeEntity } from "bitecs";
import type { GameWorld } from "world";
import type { InventorySlots } from "components";

export function inventorySystem(world: GameWorld): GameWorld {
  for (const playerEid of query(world, [Player, Transform])) {
    for (const itemEid of query(world, [Item, Transform])) {
      const dist = Math.hypot(
        Transform.x[playerEid] - Transform.x[itemEid],
        Transform.y[playerEid] - Transform.y[itemEid],
      );

      if (dist > 16) continue;

      const slots = Inventory[playerEid];
      if (!slots) continue;

      const slotKeys: (keyof InventorySlots)[] = ["slot0", "slot1", "slot2", "slot3"];
      for (const key of slotKeys) {
        if (slots[key] === 0) {
          slots[key] = itemEid;
          break;
        }
      }

      removeEntity(world, itemEid);
    }
  }

  return world;
}
