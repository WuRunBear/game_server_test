import { query } from "bitecs";
import { Inventory, Transform, Player, Item, ItemMeta, entityMapOf } from "components";
import type { GameWorld } from "world";
import { addToInventory } from "framework/systems/gameplay/inventoryOps";
import { destroyEntity } from "framework/entities/destroyEntity";

/**
 * 拾取判定的实体地图 id：mapId 解析不到已构建图（归属异常 = 配置/存档 bug）
 * 时**不改写归属**——记 error 并原样返回，与任何真实图比较即自然跳过该实体
 * （全量常驻后不允许静默踢回默认图的旧纠偏行为）。
 */
function effectiveMapOf(world: GameWorld, eid: number): string {
  const m = entityMapOf(world, eid);
  if (m !== "" && !world.maps[m]) {
    world.logger.error("entity mapId does not resolve to a known map; entity skipped", {
      eid,
      mapId: m,
    });
  }
  return m;
}

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
      if (effectiveMapOf(world, itemEid) !== effectiveMapOf(world, playerEid)) continue;

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