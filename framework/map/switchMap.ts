/**
 * 地图生命周期原子操作（per-player 地图归属，无异步 I/O，可入 tick）。
 *
 * 核心语义：世界只有一个共享 ECS，实体经 `EntityMap`（AoS）标记所属地图。
 * 本模块提供三条原子：
 * - `ensureMapActive`：确保地图已构建（world.maps 惰性缓存）并已激活
 *   （world.activeMaps + 初始 NPC 布置），幂等；
 * - `movePlayerToMap`：把单个玩家移动到目标图（换图 + 传送），
 *   目标图无效返回 false（世界状态不变）；
 * - `spawnInitialNpcs`：按某图 spawns.npcs 布置初始 NPC（归属写入 EntityMap）。
 *
 * 房间级语义（全员换图/清场）已移除：地图激活按需惰性构建，清场/传送只发生在
 * 实体级移动（movePlayerToMap）。读档恢复走 `ensureMapActive`——存档实体是用户
 * 状态，不做清场（清场只属于 portal 触发的场景切换路径，见 todo 5）。
 */
import { Transform } from "components";
import { EntityMap } from "framework/components/entityMap";
import { spawnEntity } from "framework/entities/spawn";
import { buildMapRuntime } from "framework/map/buildRuntime";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { ArchetypeRegistry } from "framework/entities/archetypeRegistry";
import type { GameWorld, EntityId } from "framework/world";

/**
 * 按某地图的 spawns.npcs 布置初始 NPC 实体（场景布置，供启动与激活复用）。
 *
 * 每个 NPC 实体生成后直接写入 `EntityMap[eid] = mapId`（地图归属；spawnEntity
 * 的 overrides.mapId 路径由 spawn 链任务负责，此处显式写保持原子独立）。
 * 目标图未构建（world.maps 缺失）或无 NPC 出生点配置时 no-op。
 */
export function spawnInitialNpcs(world: GameWorld, mapId: string): void {
  const runtime = world.maps[mapId];
  if (!runtime || runtime.spawns.npcs.length === 0) return;
  const archetypeRegistry = world.archetypes as ArchetypeRegistry;
  const componentRegistry = world.components_registry as ComponentRegistry;
  for (const spawn of runtime.spawns.npcs) {
    const archetype = archetypeRegistry.get(spawn.kind);
    const eid = spawnEntity(world, archetype, componentRegistry, {
      x: spawn.pos.x,
      y: spawn.pos.y,
    });
    EntityMap[eid] = mapId;
  }
}

/**
 * 确保某地图已构建并激活（幂等）。
 *
 * 1. 地图 id 不在 `gameDef.resolvedMapSources` → 返回 false（世界状态不变）；
 * 2. `world.maps` 缺该图 → 按 `resolvedMapSources[mapId]` 构建 MapRuntime，
 *    以 `source.id` 为 key 写入缓存（与开机默认图 / 既有消费方的派生一致：
 *    注册表条目无显式 id 时 source.id === registry key）；
 * 3. 地图未激活 → 加入 `world.activeMaps` 并布置初始 NPC；
 *    已激活则跳过（二次激活不重复布置 NPC）。
 *
 * @returns 地图 id 有效则 true；否则 false
 */
export function ensureMapActive(world: GameWorld, mapId: string): boolean {
  const source = world.gameDef.resolvedMapSources?.[mapId];
  if (!source) return false;

  if (!world.maps[source.id]) {
    world.maps[source.id] = buildMapRuntime(source);
  }
  if (!world.activeMaps.has(mapId)) {
    world.activeMaps.add(mapId);
    spawnInitialNpcs(world, mapId);
  }
  return true;
}

/**
 * 把单个玩家移动到目标地图（换图 + 传送）。
 *
 * - 目标图未激活时自动激活（ensureMapActive 语义；无效图返回 false 不移动）；
 * - 写入 `EntityMap[eid] = mapId`（AoS 直接写，不经 spawn 链）；
 * - 坐标取 `dest`（缺省目标图 spawns.player；无出生点配置回退 (0,0)）；
 * - 同图 move 同样传送（传送即语义，非 no-op）。
 *
 * @returns 是否移动成功
 */
export function movePlayerToMap(
  world: GameWorld,
  eid: EntityId,
  mapId: string,
  dest?: { x: number; y: number },
): boolean {
  if (!ensureMapActive(world, mapId)) return false;

  EntityMap[eid] = mapId;
  const spawn = world.maps[mapId].spawns.player ?? { x: 0, y: 0 };
  Transform.x[eid] = dest?.x ?? spawn.x;
  Transform.y[eid] = dest?.y ?? spawn.y;
  // TODO(map): call prewarmCollisionRuntime(world, mapId) once collisionSystem per-map runtime lands (todo 6)
  return true;
}
