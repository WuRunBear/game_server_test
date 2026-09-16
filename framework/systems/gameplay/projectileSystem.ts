/**
 * projectileSystem：直线运动投射物的移动、墙阻挡、接触判定与寿命销毁。
 *
 * 每 tick 对 [Projectile, Transform] 实体：
 * 1. 按速度向量位移（像素/秒 × dtSec）；
 * 2. 目标格不可走（walkableAt，与 collisionSystem 同源的地图查询）→ 销毁；
 * 3. 接触判定：与同图其他实体（非主人、非投射物）距离 <= 半径 + 垫片
 *    → 发 on-contact 事件（类型化事件总线）→ 销毁（无穿透，命中闭环
 *    留配方切片）；
 * 4. 寿命递减归零 → 销毁。
 *
 * 游戏无关——速度/寿命/半径全为通用机制参数，投射物行为由效果与配置声明。
 */
import { hasComponent, query, addComponent, addEntity } from "bitecs";
import { Projectile, Transform, NetworkId, entityMapOf, EntityMap } from "components";
import type { GameWorld, EntityId } from "world";
import { destroyEntity } from "framework/entities/destroyEntity";
import { walkableAt } from "map/geometry/query";
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
  setEntityKind(world, eid, "projectile");
  return eid;
}

/** 投射物 tick 体：移动 → 墙阻挡 → 接触 → 寿命。 */
export function projectileSystem(world: GameWorld): GameWorld {
  const dtSec = world.time.dtMs / 1000;

  for (const eid of query(world, [Projectile, Transform])) {
    const nx = Transform.x[eid] + Projectile.vx[eid] * dtSec;
    const ny = Transform.y[eid] + Projectile.vy[eid] * dtSec;
    const mapId = entityMapOf(world, eid);

    // 墙阻挡：目标格不可走 → 销毁（越界 walkableAt 返回 false 同样销毁）
    const geometry = world.maps[mapId];
    if (geometry) {
      const tx = Math.floor(nx / geometry.grid.tileWidth);
      const ty = Math.floor(ny / geometry.grid.tileHeight);
      if (!walkableAt(geometry, tx, ty)) {
        destroyEntity(world, eid);
        continue;
      }
    }

    // 接触判定：对同图其他实体（非主人、非投射物）做距离检查，命中即发事件销毁
    const radius = Projectile.radius[eid];
    const owner = Projectile.owner[eid];
    let hit: EntityId | undefined;
    for (const other of query(world, [Transform, NetworkId])) {
      if (other === eid || other === owner) continue;
      if (hasComponent(world, other, Projectile)) continue;
      // 分图隔离：仅与投射物同图实体判定接触（与 combat 同语义）
      if (entityMapOf(world, other) !== mapId) continue;
      const d = Math.hypot(Transform.x[other] - nx, Transform.y[other] - ny);
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
