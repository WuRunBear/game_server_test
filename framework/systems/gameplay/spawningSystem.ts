/**
 * spawningSystem：按刷怪规则周期刷出实体（tick 系统）。
 *
 * - 规则源：gameDef.resolvedSpawns（game/maps/registry.json 的 spawns 声明），
 *   每条规则独立计时，间隔 respawnMs 毫秒。
 * - 作用域：规则限定在声明的地图（mapId）与区域（zoneId）内生效；按
 *   rule.kind 统计区域内当前实体数（不限定 NPC 标签，资源节点等也可刷），
 *   达到 max 后本周期不刷。
 * - 条件刷怪：rule.condition 引用 spawnConditions 注册的条件（如 isNight），
 *   不满足则本周期不刷且不重置计时——条件满足后的下一个计时窗口自动生效。
 * - 落点：区域内随机采样（多边形做包含性重试，退化场景回退包围盒随机点）。
 * - 计时状态跨 tick 存于 world.systemRuntimes。
 *
 * 游戏无关——刷什么实体（kind → archetype）与何时刷全由配置声明。
 */
import { query } from "bitecs";
import { Transform, Kind } from "components";
import type { GameWorld } from "world";
import { spawnEntity } from "framework/entities/spawn";
import type { ArchetypeRegistry } from "framework/entities/archetypeRegistry";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { SpawnRule } from "framework/config/schema/GameDefinitionSchema";
import { hasSpawnCondition, getSpawnCondition } from "framework/systems/gameplay/spawnConditions";
import { pointInPolygon } from "framework/utils/geometry";

/** 单条刷怪规则的计时状态（world.systemRuntimes 持久）。 */
interface SpawnTimer {
  /** 上次刷出时刻（毫秒；首帧初始化为 -Infinity 保证规则立即生效） */
  lastSpawnTime: number;
  /** 该计时对应的规则引用 */
  rule: SpawnRule;
}

const SPAWN_KEY = "spawning";
const RANDOM_POINT_MAX_RETRIES = 16;

/** 取（或惰性创建）刷怪计时列表——按规则引用惰性建条目，跨 tick 保持。 */
function getSpawnTimers(world: GameWorld): SpawnTimer[] {
  let timers = world.systemRuntimes.get(SPAWN_KEY) as SpawnTimer[] | undefined;
  if (timers) return timers;
  timers = [];
  world.systemRuntimes.set(SPAWN_KEY, timers);
  return timers;
}

/** 统计 zoneId 区域内当前存在的 kind 实体数（多边形外的实体不计）。 */
function countInZone(world: GameWorld, kind: string, zoneId: number): number {
  const zone = world.map?.zones.find((z) => z.id === zoneId);
  if (!zone) return 0;

  const hasPoly = zone.polygon.length >= 3;
  let count = 0;
  // 按 Kind + zone 计数，不限定 NPC 标签——否则非 NPC 类型的 spawn rule
  // （如资源节点、S4 夜刷狼）max 上限永不生效，会无限刷出
  for (const eid of query(world, [Transform])) {
    if (Kind[eid] !== kind) continue;
    if (hasPoly && !pointInPolygon(Transform.x[eid], Transform.y[eid], zone.polygon)) continue;
    count++;
  }

  return count;
}

/**
 * 在 zone 内随机取点：多边形做包含性重试采样（命中即返回）；
 * 重试耗尽或非多边形（点数 < 3）时退化为包围盒内随机点。
 */
function randomPointInZone(zone: { polygon: { x: number; y: number }[] }): { x: number; y: number } {
  if (zone.polygon.length === 0) return { x: 0, y: 0 };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of zone.polygon) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  if (zone.polygon.length < 3) {
    return {
      x: minX + Math.random() * (maxX - minX),
      y: minY + Math.random() * (maxY - minY),
    };
  }

  for (let i = 0; i < RANDOM_POINT_MAX_RETRIES; i++) {
    const x = minX + Math.random() * (maxX - minX);
    const y = minY + Math.random() * (maxY - minY);
    if (pointInPolygon(x, y, zone.polygon)) return { x, y };
  }

  return {
    x: minX + Math.random() * (maxX - minX),
    y: minY + Math.random() * (maxY - minY),
  };
}

export function spawningSystem(world: GameWorld): GameWorld {
  const rules = world.gameDef.resolvedSpawns;
  if (rules.length === 0) return world;

  const timers = getSpawnTimers(world);
  const archetypeRegistry = world.archetypes as ArchetypeRegistry;
  const componentRegistry = world.components_registry as ComponentRegistry;
  const now = world.time.tick * world.time.fixedDtMs;

  for (const rule of rules) {
    // 地图限定：规则只在其声明的地图（world.map.id）生效；
    // portal 场景切换后 world.map 变化，各图规则随之切换作用图
    if (rule.mapId && rule.mapId !== world.map?.id) continue;

    let timer = timers.find((t) => t.rule === rule);
    if (!timer) {
      timer = { lastSpawnTime: -Infinity, rule };
      timers.push(timer);
    }

    if (now - timer.lastSpawnTime < rule.respawnMs) continue;

    // 条件刷怪（如夜刷狼）：condition 不满足则本计时周期不刷，
    // 但不重置 timer——满足条件后的下一个计时窗口自动生效
    if (rule.condition) {
      if (!hasSpawnCondition(rule.condition)) {
        throw new Error(`Spawn rule for "${rule.kind}" references unknown condition "${rule.condition}"`);
      }
      if (!getSpawnCondition(rule.condition)(world)) continue;
    }

    const currentCount = countInZone(world, rule.kind, rule.zoneId);
    if (currentCount >= rule.max) continue;

    const zone = world.map?.zones.find((z) => z.id === rule.zoneId);
    if (!zone) continue;

    const archetype = archetypeRegistry.get(rule.kind);
    const pos = randomPointInZone(zone);

    spawnEntity(world, archetype, componentRegistry, { x: pos.x, y: pos.y });
    timer.lastSpawnTime = now;
  }

  return world;
}
