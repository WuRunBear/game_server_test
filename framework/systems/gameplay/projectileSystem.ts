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
import {
  Projectile,
  Transform,
  NetworkId,
  Health,
  Defense,
  Attack,
  Cooldown,
  Enemy,
  Velocity,
  entityMapOf,
  EntityMap,
} from "components";
import { EntityLevel, entityLevelOf } from "framework/components/entityLevel";
import { isOfflineRetained } from "components/offline";
import { isPassageOpen } from "components/passage";
import { sameLevelDistance } from "framework/utils/gameplayDistance";
import type { GameWorld, EntityId } from "world";
import { destroyEntity } from "framework/entities/destroyEntity";
import { walkableAtLevel } from "map/geometry/query";
import { collectBuiltStructures, type BuiltStructuresIndex } from "framework/map/runtime/builtStructures";
import { queueEvent } from "framework/simulation/events/eventBus";
import { emitEvent } from "framework/events/gameEvents";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import { getEquippedItemKind } from "framework/systems/gameplay/equipmentSystem";
import { getEquipModifiers } from "framework/systems/gameplay/equipmentSystem";
import { getSkillAdd, getSkillMultiplier } from "framework/systems/gameplay/progression";
import { computeStandardDamage } from "framework/systems/gameplay/damageFormula";
import {
  computeNumericStat,
  STAT_ATTACK,
  STAT_DEFENSE,
} from "framework/simulation/modifiers/modifiers";
import { wearEquippedItem } from "framework/systems/gameplay/durability";

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
  damage = 0,
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
  Projectile.damage[eid] = damage;
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

    // 墙阻挡：目标格在投射物层视角下不可走，或该格有同层建造墙（含可建造
    // 屏障）→ 销毁（越界同样销毁；cliff 格对不高于投射物层号的视角单向
    // 可越，与 collisionSystem 同源规则；楼板实体所在格在楼板层视角下可越——
    // 楼板不挡同层投射物）
    const geometry = world.maps[mapId];
    const built = builtOf(mapId);
    if (geometry) {
      const tx = Math.floor(nx / geometry.grid.tileWidth);
      const ty = Math.floor(ny / geometry.grid.tileHeight);
      const tileIndex = ty * geometry.grid.width + tx;
      const wallBlocked = built?.walls.get(level)?.has(tileIndex) ?? false;
      if (wallBlocked || !walkableAtLevel(geometry, tx, ty, level, built)) {
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
      // 打开的通行口放行投射物（关闭时作为实体墙参与接触与伤害）
      if (isPassageOpen(world, other)) continue;
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
      // 命中伤害闭环：damage > 0 且目标有 Health 时按标准公式（含防御）结算；
      // 防御读取与 combat/damage 效果同源。伤害在 on-contact 事件之前落账，
      // 事件消费方（触发器/任务）看到的是命中后的血量。
      const rawDamage = Projectile.damage[eid];
      if (rawDamage > 0 && hasComponent(world, hit, Health) && (Health.current[hit] ?? 0) > 0) {
        const defense =
          (Defense.value[hit] ?? 0) +
          getEquipModifiers(world, hit).defenseBonus +
          getSkillAdd(world, hit, STAT_DEFENSE);
        const effectiveDefense =
          computeNumericStat(world, hit, STAT_DEFENSE, defense) *
          getSkillMultiplier(world, hit, STAT_DEFENSE);
        const applied = computeStandardDamage(rawDamage, effectiveDefense);
        Health.current[hit] = (Health.current[hit] ?? 0) - applied;
        queueEvent(world, "on-hit", {
          eid: owner,
          attacker: owner,
          target: hit,
          damage: applied,
        });
        if ((Health.current[hit] ?? 0) <= 0) {
          emitEvent(world, "killed", {
            killer: owner,
            victim: hit,
            kind: "",
          });
        }
      }
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

/** 取规则里的近战冷却作为投掷冷却缺省（rules/combat.json 的 attackCooldownMs）。 */
function defaultCooldownMs(world: GameWorld): number {
  const rules = world.gameDef.resolvedRules["combat"] as { attackCooldownMs?: number } | undefined;
  const value = rules?.attackCooldownMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 1000;
}

/** 投掷者当前攻击力（组件基础 + 装备/技能加法 → 属性修饰符 → 技能乘法），与 combat 同序。 */
function attackPowerOf(world: GameWorld, eid: EntityId): number {
  const base =
    (Attack.value[eid] ?? 10) +
    getEquipModifiers(world, eid).attackBonus +
    getSkillAdd(world, eid, STAT_ATTACK);
  return computeNumericStat(world, eid, STAT_ATTACK, base) * getSkillMultiplier(world, eid, STAT_ATTACK);
}

/**
 * 解析投掷方向（单位向量）。确定性优先级：
 * 1. 显式瞄准点（PlayerCommand `throw` 的 x/y；相对投掷者的方向）；
 * 2. 射程内最近的同图同层 Enemy（攻击目标方向）；
 * 3. 当前移动速度方向（移动朝向）；
 * 4. 缺省 +x。
 */
function resolveThrowAim(
  world: GameWorld,
  eid: EntityId,
  aimX: number | undefined,
  aimY: number | undefined,
  range: number,
  mapId: string,
  level: number,
): { x: number; y: number } {
  const px = Transform.x[eid];
  const py = Transform.y[eid];

  if (typeof aimX === "number" && typeof aimY === "number" && Number.isFinite(aimX) && Number.isFinite(aimY)) {
    const dx = aimX - px;
    const dy = aimY - py;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) return { x: dx / len, y: dy / len };
  }

  let nearest: EntityId | undefined;
  let nearestDist = Infinity;
  for (const enemy of query(world, [Enemy, Transform])) {
    if (entityMapOf(world, enemy) !== mapId) continue;
    const d = sameLevelDistance(
      px,
      py,
      level,
      Transform.x[enemy],
      Transform.y[enemy],
      entityLevelOf(enemy),
    );
    if (d === undefined || d > range) continue;
    if (d < nearestDist) {
      nearest = enemy;
      nearestDist = d;
    }
  }
  if (nearest !== undefined) {
    const dx = Transform.x[nearest] - px;
    const dy = Transform.y[nearest] - py;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) return { x: dx / len, y: dy / len };
  }

  const vx = hasComponent(world, eid, Velocity) ? Velocity.vx[eid] : 0;
  const vy = hasComponent(world, eid, Velocity) ? Velocity.vy[eid] : 0;
  const len = Math.hypot(vx, vy);
  if (len > 1e-6) return { x: vx / len, y: vy / len };

  return { x: 1, y: 0 };
}

/**
 * 投掷原子（PlayerCommand `throw` 的服务端权威入口）。
 *
 * 前置：weapon 槽物品声明 `throw` 档案；投掷者未死亡；Cooldown 就绪。
 * 行为：解析方向 → 生成投射物（速度/寿命/半径/伤害全配置，确定性）→ 写冷却
 * → 武器磨损。不发伤害——命中结算归 projectileSystem（on-contact 闭环）。
 *
 * @param aimX / aimY 瞄准点（世界坐标，可选；缺省按最近敌人→移动朝向→+x）
 * @returns 是否成功投出
 */
export function throwWeapon(
  world: GameWorld,
  playerEid: EntityId,
  aimX?: number,
  aimY?: number,
): boolean {
  if (!hasComponent(world, playerEid, Transform)) return false;
  if (hasComponent(world, playerEid, Health) && (Health.current[playerEid] ?? 0) <= 0) return false;

  const item = getEquippedItemKind(world, playerEid, "weapon");
  const profile = item?.throw;
  if (!profile) return false;

  const speed = profile.speed;
  const lifeMs = profile.lifeMs;
  if (!(typeof speed === "number" && Number.isFinite(speed) && speed > 0)) return false;
  if (!(typeof lifeMs === "number" && Number.isFinite(lifeMs) && lifeMs > 0)) return false;
  if (hasComponent(world, playerEid, Cooldown) && (Cooldown.remainingMs[playerEid] ?? 0) > 0) {
    return false;
  }

  const mapId = entityMapOf(world, playerEid);
  const level = entityLevelOf(playerEid);
  const range = (speed * lifeMs) / 1000;
  const dir = resolveThrowAim(world, playerEid, aimX, aimY, range, mapId, level);
  const damage =
    typeof profile.damage === "number" && Number.isFinite(profile.damage)
      ? profile.damage
      : attackPowerOf(world, playerEid);
  const radius =
    typeof profile.radius === "number" && Number.isFinite(profile.radius) && profile.radius >= 0
      ? profile.radius
      : 4;

  spawnProjectile(
    world,
    playerEid,
    Transform.x[playerEid],
    Transform.y[playerEid],
    dir.x * speed,
    dir.y * speed,
    lifeMs,
    radius,
    damage,
  );

  const cooldown =
    typeof profile.cooldownMs === "number" && Number.isFinite(profile.cooldownMs) && profile.cooldownMs >= 0
      ? profile.cooldownMs
      : defaultCooldownMs(world);
  if (hasComponent(world, playerEid, Cooldown)) {
    Cooldown.remainingMs[playerEid] = cooldown;
  }
  // 投掷磨损武器耐久（与近战命中磨损同源；无耐久物品为 no-op）
  wearEquippedItem(world, playerEid, "weapon");
  return true;
}
