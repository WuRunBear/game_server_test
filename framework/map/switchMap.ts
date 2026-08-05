/**
 * 地图切换——运行时替换 world.map 的同步原子（无异步 I/O，可入 tick）。
 *
 * - `setWorldMap`：仅替换地图网格/出生点/区域，并**选择性重建**系统运行时缓存：
 *   collisionSystem 的 mapBodies 与 spawningSystem 的计时器是惰性缓存
 *   （首次 tick 构建在 world.systemRuntimes），不重建则旧图碰撞体/刷怪计时残留；
 *   其余缓存（aiSystem 黑名单 / deathSystem 重生标记）与地图无关，保留
 *   （重生标记丢失会重复掷掉落并重置重生延迟）。
 * - `enterMap`：场景切换（portal 触发）——换图 + 清场（销毁非玩家内容的
 *   场景实体）+ 按新图 spawns 布置 + 传送玩家。
 *
 * 清场保留判定（玩家内容，游戏无关）：Player tag / Placeable（玩家放置物）/
 * ItemMeta（地面掉落）——资源节点、NPC、刷怪实体等场景生态随图重置。
 *
 * 读档恢复（restoreWorld）走 `setWorldMap` 而非 `enterMap`：
 * 存档实体是用户状态，不做清场（清场只属于 portal 触发的场景切换路径）。
 */
import { hasComponent, query } from "bitecs";

import { NetworkId, Player, Placeable, ItemMeta, Transform } from "components";
import { spawnEntity } from "framework/entities/spawn";
import { destroyEntity } from "framework/entities/destroyEntity";
import { buildMapRuntime } from "framework/map/buildRuntime";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { ArchetypeRegistry } from "framework/entities/archetypeRegistry";
import type { GameWorld, EntityId } from "framework/world";

/** 按当前 world.map 的 spawns.npcs 生成初始 NPC 实体（场景布置，供启动与切图复用）。 */
export function spawnInitialNpcs(world: GameWorld): void {
  if (!world.map) return;
  const archetypeRegistry = world.archetypes as ArchetypeRegistry;
  const componentRegistry = world.components_registry as ComponentRegistry;
  for (const spawn of world.map.spawns.npcs) {
    const archetype = archetypeRegistry.get(spawn.kind);
    spawnEntity(world, archetype, componentRegistry, {
      x: spawn.pos.x,
      y: spawn.pos.y,
    });
  }
}

/** 玩家内容判定：Player tag / 放置物 / 地面掉落（清场保留）。
 *  ItemMeta 为 AoS 组件（无 bitecs 组件标志），按数据存在性判定。 */
function isPlayerContent(world: GameWorld, eid: EntityId): boolean {
  return (
    hasComponent(world, eid, Player) ||
    hasComponent(world, eid, Placeable) ||
    ItemMeta[eid] !== undefined
  );
}

/** 换图必须重建的惰性缓存 key（collisionSystem mapBodies / spawningSystem 计时器）。 */
const MAP_BOUND_RUNTIME_KEYS = ["collision", "spawning"];

/**
 * 仅替换 world.map（含地图相关缓存重建），不清场不布置。
 *
 * @returns 是否切换成功（目标图已存在于配置；已是目标图视为成功）
 */
export function setWorldMap(world: GameWorld, mapId: string): boolean {
  const sources = world.gameDef.resolvedMapSources;
  const source = sources?.[mapId];
  if (!source) return false;
  if (world.map?.id === mapId) return true;

  world.map = buildMapRuntime(source);
  for (const key of MAP_BOUND_RUNTIME_KEYS) {
    world.systemRuntimes.delete(key);
  }
  return true;
}

/**
 * 场景切换（portal 触发）：换图 + 清场 + 布置 + 传送玩家。
 *
 * 清场：销毁全部非玩家内容实体（destroyEntity 统一出口，防 AoS 残留）。
 * 布置：按新图 spawns.npcs 生成初始实体（spawningSystem 计时器已随缓存清空重置）。
 * 传送：全部玩家实体移动到 destination（缺省新图出生点）。
 *
 * @returns 是否切换成功
 */
export function enterMap(
  world: GameWorld,
  mapId: string,
  destination?: { x: number; y: number },
): boolean {
  if (!setWorldMap(world, mapId)) return false;

  for (const eid of [...query(world, [NetworkId])]) {
    if (isPlayerContent(world, eid)) continue;
    destroyEntity(world, eid);
  }

  spawnInitialNpcs(world);

  const dest = destination ?? world.map?.spawns.player ?? { x: 0, y: 0 };
  for (const eid of query(world, [Transform, Player])) {
    Transform.x[eid] = dest.x;
    Transform.y[eid] = dest.y;
  }
  return true;
}
