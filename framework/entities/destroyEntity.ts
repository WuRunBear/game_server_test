/**
 * 实体销毁——bitecs removeEntity + AoS 残留清理的统一出口。
 *
 * bitecs 的 removeEntity 只清 SoA 数值数组；AoS 组件（Inventory / Kind / Needs /
 * ResourceNode / ItemMeta / Intent / LootTable 等普通 JS 数组）按 eid 索引的条目
 * 不会被清。若不清，eid 被复用后残留数据会被世界序列化（worldSerializer）写进
 * 存档并跨存档循环。所有删除实体的调用点必须走本函数。
 */
import { removeEntity } from "bitecs";

import type { GameWorld } from "framework/world";

/**
 * 销毁实体：先调 bitecs removeEntity 清掉 SoA 数值数组条目，
 * 再遍历组件注册表，把全部 AoS 组件中该 eid 的残留条目置为 undefined。
 * 所有删除实体的调用点必须走本函数（缘由见文件头注释）。
 */
export function destroyEntity(world: GameWorld, eid: number): void {
  removeEntity(world, eid);

  const registry = world.components_registry;
  for (const [name, comp] of Object.entries(registry.all())) {
    // 只处理 AoS 组件（普通 JS 数组）；SoA 数值数组已由 removeEntity 清理
    if (!registry.isAosComponent(name)) continue;
    const arr = comp as unknown[];
    if (arr[eid] !== undefined) {
      arr[eid] = undefined;
    }
  }
}
