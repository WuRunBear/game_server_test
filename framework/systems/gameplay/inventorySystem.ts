import { query } from "bitecs";
import { Inventory, Transform, Player, Item, ItemMeta } from "components";
import type { GameWorld } from "world";
import { addToInventory } from "framework/systems/gameplay/inventoryOps";
import { destroyEntity } from "framework/entities/destroyEntity";

/**
 * inventorySystem：自动拾取。玩家靠近地面 item 实体时把其堆叠并入背包。
 *
 * - 读取 item 的 ItemMeta（kind/count/pickupAfterMs）；pickupAfterMs 未到则跳过
 *   （防「丢下即被拾回」）
 * - addToInventory 支持部分入：全入→移除 item 实体；部分入→回写剩余 count；
 *   一点不入→保留 Defect-3 的「满包不吞物品」语义（不动 item）
 */
export function inventorySystem(world: GameWorld): GameWorld {
  const itemsByKind = world.gameDef.itemsByKind;
  const now = world.time.tick * world.time.fixedDtMs;

  for (const playerEid of query(world, [Player, Transform])) {
    const inv = Inventory[playerEid];
    if (!inv) continue;

    for (const itemEid of query(world, [Item, Transform])) {
      const meta = ItemMeta[itemEid];
      if (!meta) continue;
      if (now < meta.pickupAfterMs) continue;

      const dist = Math.hypot(
        Transform.x[playerEid] - Transform.x[itemEid],
        Transform.y[playerEid] - Transform.y[itemEid],
      );
      if (dist > 16) continue;

      const leftover = addToInventory(inv, itemsByKind, meta.kind, meta.count);
      if (leftover <= 0) {
        destroyEntity(world, itemEid);
      } else if (leftover < meta.count) {
        meta.count = leftover;
      }
      // leftover === meta.count → 满包不入，保留 item（Defect-3）
    }
  }

  return world;
}