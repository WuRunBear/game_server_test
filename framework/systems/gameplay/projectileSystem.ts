/**
 * projectileSystem：直线运动投射物的移动、墙阻挡、接触判定与寿命销毁。
 *
 * 每 tick 对 [Projectile, Transform] 实体：
 * 1. 按速度向量位移（像素/秒 × dtSec）；
 * 2. 目标格在投射物层视角下不可走（walkableAtLevel，与 collisionSystem
 *    同源的按层地图查询）→ 销毁；
 * 3. 接触判定：与同图同层的其他实体（非主人、非投射物）距离 <= 半径 + 垫片
 *    → 发 on-contact 事件（类型化事件总线）→ 销毁（无穿透，命中闭环
 *    留配方切片）；投射物锁单层（生成时随主人层号定格，异层不构成接触
 *    目标，跨层射击 v1 不支持）；
 * 4. 寿命递减归零 → 销毁。
 *
 * 游戏无关——速度/寿命/半径全为通用机制参数，投射物行为由效果与配置声明。
 */
import { hasComponent, query, addComponent, addEntity } from "bitecs";
import { Projectile, Transform, NetworkId, entityMapOf, EntityMap } from "components";
import { EntityLevel, entityLevelOf } from "framework/components/entityLevel";
import { isOfflineRetained } from "components/offline";
import { sameLevelDistance } from "framework/utils/gameplayDistance";
import type { GameWorld, EntityId } from "world";
import { destroyEntity } from "framework/entities/destroyEntity";
import { walkableAtLevel } from "map/geometry/query";
import { collectBuiltStructures, type BuiltStructuresIndex } from "framework/map/runtime/builtStructures";
import { queueEvent } from "framework/simulation/events/eventBus";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";

/** 接触判定垫片（像素）：目标实体无半径数据时的等效半径。 */
const CONTACT_PADDING = 4;

/** 生成一个投射物实体（spawn-projectile 效果的承载路径）。 */
export function spawnProjectile(
  world: GameWorld,
  ownerEid: EntityId,
  x: number,
  y: number,
  vx: number,
  vy: number,
  lifeMs: number,
  radius: number,
): EntityId {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Projectile);
  Transform.x[eid] = x;
  Transform.y[eid] = y;
  Projectile.owner[eid] = ownerEid;
  Projectile.vx[eid] = vx;
  Projectile.vy[eid] = vy;
  Projectile.lifeMs[eid] = lifeMs;
  Projectile.radius[eid] = radius;
  NetworkId.value[eid] = world.nextNetworkId++;
  // 投射物无 archetype（框架通用实体），归属与 kind 随主人地图 / 通用名
  EntityMap[eid] = entityMapOf(world, ownerEid);
  // 投射物锁单层（前置修正 5）：生成时定格主人的层号，飞行中不随地形变化
  // （entityLevelSystem 对 Projectile 跳过）；只与同层实体/墙结算接触，
  // 跨层射击 v1 明确不支持（配置层后续放开）。
  EntityLevel[eid] = entityLevelOf(ownerEid);
  setEntityKind(world, eid, "projectile");
  return eid;
}

/** 投射物 tick 体：移动 → 墙阻挡 → 接触 → 寿命。 */
export function projectileSystem(world: GameWorld): GameWorld {
  const dtSec = world.time.dtMs / 1000;
  // 建造层索引按图缓存（本 tick 内复用；楼板参与墙阻挡判定——前置修正 3）
  const builtByMap = new Map<string, BuiltStructuresIndex>();
  const builtOf = (mapId: string): BuiltStructuresIndex | undefined => {
    if (!world.maps[mapId]) return undefined;
    let built = builtByMap.get(mapId);
    if (!built) {
      built = collectBuiltStructures(world, mapId);
      builtByMap.set(mapId, built);
    }
    return built;
  };

  for (const eid of query(world, [Projectile, Transform])) {
    const nx = Transform.x[eid] + Projectile.vx[eid] * dtSec;
    const ny = Transform.y[eid] + Projectile.vy[eid] * dtSec;
    const mapId = entityMapOf(world, eid);
    const level = entityLevelOf(eid);

    // 墙阻挡：目标格在投射物层视角下不可走 → 销毁（越界同样销毁；
    // cliff 格对不高于投射物层号的视角单向可越，与 collisionSystem 同源规则；
    // 楼板实体所在格在楼板层视角下可越——楼板不挡同层投射物）
    const geometry = world.maps[mapId];
    if (geometry) {
      const tx = Math.floor(nx / geometry.grid.tileWidth);
      const ty = Math.floor(ny / geometry.grid.tileHeight);
      if (!walkableAtLevel(geometry, tx, ty, level, builtOf(mapId))) {
        destroyEntity(world, eid);
        continue;
      }
    }

    // 接触判定：对同图同层其他实体（非主人、非投射物）做距离检查，命中即发事件销毁
    const radius = Projectile.radius[eid];
    const owner = Projectile.owner[eid];
    let hit: EntityId | undefined;
    for (const other of query(world, [Transform, NetworkId])) {
      if (other === eid || other === owner) continue;
      if (hasComponent(world, other, Projectile)) continue;
      // 断线保留期实体不被投射物命中（不可见 = 不构成接触目标）
      if (isOfflineRetained(world, other)) continue;
      // 分图隔离：仅与投射物同图实体判定接触（与 combat 同语义）
      if (entityMapOf(world, other) !== mapId) continue;
      // 统一距离检查（前置修正 4）：同层欧氏距离（异层不构成接触目标——
      // 锁单层语义经 sameLevelDistance 的异层 undefined 表达，原显式层级
      // 过滤 + Math.hypot 合并为单一判定源）
      const d = sameLevelDistance(nx, ny, level, Transform.x[other], Transform.y[other], entityLevelOf(other));
      if (d === undefined) continue;
      if (d <= radius + CONTACT_PADDING) {
        hit = other;
        break;
      }
    }

    Transform.x[eid] = nx;
    Transform.y[eid] = ny;

    if (hit !== undefined) {
      queueEvent(world, "on-contact", {
        eid: owner,
        target: hit,
        x: nx,
        y: ny,
      });
      destroyEntity(world, eid);
      continue;
    }

    // 寿命递减，归零销毁
    const life = Projectile.lifeMs[eid] - world.time.dtMs;
    if (life <= 0) {
      destroyEntity(world, eid);
      continue;
    }
    Projectile.lifeMs[eid] = life;
  }

  return world;
}
