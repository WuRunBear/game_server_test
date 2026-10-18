/**
 * 地图切换原子操作（per-player 地图归属，无异步 I/O，可入 tick）。
 *
 * 核心语义：世界只有一个共享 ECS，实体经 `EntityMap`（AoS）标记所属地图。
 * 本模块只提供 `movePlayerToMap`：把单个玩家移动到目标图（换图 + 传送），
 * 目标图无效返回 false（世界状态不变）。
 *
 * 旧地图生命周期原语（惰性构建 + 初始 NPC 布置）已随核心切换消亡：地图由
 * 开机 bootMaps 全量构建并常驻激活（world.maps + world.activeMaps），实体
 * 生产唯一路径是演化引擎——本模块不再承担任何构建/布置职责。
 */
import { Transform } from "components";
import { EntityMap } from "framework/components/entityMap";
import { EntityLevel } from "framework/components/entityLevel";
import { prewarmCollisionRuntime } from "framework/systems/core/collisionSystem";
import type { GameWorld, EntityId } from "framework/world";

/**
 * 把单个玩家移动到目标地图（换图 + 传送）。
 *
 * - `mapId` 是 registry key（运行时规范化键，即 world.maps 的查找键）；
 *   目标图未构建（world.maps 缺键）→ 返回 false 不移动；
 * - 写入 `EntityMap[eid] = mapId`（AoS 直接写，不经 spawn 链）；
 * - 坐标取 `dest`（缺省目标图几何中心）；
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
  const geometry = world.maps[mapId];
  if (!geometry) return false;

  EntityMap[eid] = mapId;
  const fallback = {
    x: (geometry.grid.width / 2) * geometry.grid.tileWidth,
    y: (geometry.grid.height / 2) * geometry.grid.tileHeight,
  };
  Transform.x[eid] = dest?.x ?? fallback.x;
  Transform.y[eid] = dest?.y ?? fallback.y;
  // 传送 = 重新落地：层号按目标落点地形重确立（首次确立语义）。否则
  // entityLevelSystem 会把「高处传送 → 低处落点」当成一次 cliff 跳下
  // （F-17 坠落伤害），或在非 cliff 落点被语义校验永久卡在旧层。
  // 同图传送同样重新确立（movePlayerToMap 的语义是传送而非行走）。
  {
    const tx = Math.min(
      geometry.grid.width - 1,
      Math.max(0, Math.floor(Transform.x[eid] / geometry.grid.tileWidth)),
    );
    const ty = Math.min(
      geometry.grid.height - 1,
      Math.max(0, Math.floor(Transform.y[eid] / geometry.grid.tileHeight)),
    );
    EntityLevel[eid] = geometry.level[ty * geometry.grid.width + tx] ?? 0;
  }
  // 预暖目标图碰撞运行时：实体当 tick 进入一个「已有碰撞体」的世界（新激活图当 tick 即可碰撞）。
  prewarmCollisionRuntime(world, mapId);
  return true;
}
