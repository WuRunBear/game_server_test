/**
 * spawningSystem：按刷怪规则周期刷出实体（tick 系统）。
 *
 * - 规则源：gameDef.resolvedSpawns（game/spawns/*.json 的规则列表），
 *   每条规则独立计时，间隔 respawnMs 毫秒。
 * - 作用域：按「激活地图 × 规则」两两生效——声明 mapId 的规则只在其图
 *   激活时生效；缺省 mapId 的规则对全部激活图各自生效。计时按（地图, 规则）
 *   对独立存储，目标图未激活即不刷。
 * - 规则限定在生效图与区域（zoneId）内；按 rule.kind 统计该图该区域内当前
 *   实体数（他图实体不计，不限定 NPC 标签，资源节点等也可刷），达 max 后
 *   本周期不刷。
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
import { entityMapOf } from "framework/components/entityMap";
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

/** 取（或惰性创建）按图分组的刷怪计时表——mapId → 该图各规则计时，跨 tick 保持。 */
function getSpawnTimers(world: GameWorld): Map<string, SpawnTimer[]> {
  let timersByMap = world.systemRuntimes.get(SPAWN_KEY) as Map<string, SpawnTimer[]> | undefined;
  if (timersByMap) return timersByMap;
  timersByMap = new Map();
  world.systemRuntimes.set(SPAWN_KEY, timersByMap);
  return timersByMap;
}

/** 统计某图 zoneId 区域内当前存在的 kind 实体数（他图实体与多边形外的实体不计）。 */
function countInZone(world: GameWorld, mapId: string, kind: string, zoneId: number): number {
  const runtime = world.maps[mapId] ?? (world.map?.id === mapId ? world.map : undefined);
  if (!runtime) return 0;
  const zone = runtime.zones.find((z) => z.id === zoneId);
  if (!zone) return 0;

  const hasPoly = zone.polygon.length >= 3;
  let count = 0;
  // 按 Kind + 归属图 + zone 计数，不限定 NPC 标签——否则非 NPC 类型的 spawn rule
  // （如资源节点、S4 夜刷狼）max 上限永不生效，会无限刷出；他图实体不占本图上限
  for (const eid of query(world, [Transform])) {
    if (Kind[eid] !== kind) continue;
    if (entityMapOf(world, eid) !== mapId) continue;
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

  // 作用图集合：激活地图优先；激活集为空时回退弃用别名 world.map（legacy 单图语义）；
  // 两者皆空（无地图配置，如 createDefaultGameDefinition）→ no-op，不崩溃。
  const mapIds = world.activeMaps.size > 0
    ? world.activeMaps
    : world.map ? new Set([world.map.id]) : new Set<string>();
  if (mapIds.size === 0) return world;

  const timersByMap = getSpawnTimers(world);
  const archetypeRegistry = world.archetypes as ArchetypeRegistry;
  const componentRegistry = world.components_registry as ComponentRegistry;
  const now = world.time.tick * world.time.fixedDtMs;

  for (const mapId of mapIds) {
    const mapRuntime = world.maps[mapId] ?? (world.map?.id === mapId ? world.map : undefined);
    if (!mapRuntime) continue;

    // 该图的计时槽：无则惰性创建（每「（地图, 规则）」一条，跨 tick 保持，不重复建）
    let mapTimers = timersByMap.get(mapId);
    if (!mapTimers) {
      mapTimers = [];
      timersByMap.set(mapId, mapTimers);
    }

    for (const rule of rules) {
      // 地图限定：声明 mapId 的规则只在其图激活时生效；
      // 缺省 mapId 的规则对全部激活图各自生效
      if (rule.mapId && rule.mapId !== mapId) continue;

      let timer = mapTimers.find((t) => t.rule === rule);
      if (!timer) {
        timer = { lastSpawnTime: -Infinity, rule };
        mapTimers.push(timer);
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

      const currentCount = countInZone(world, mapId, rule.kind, rule.zoneId);
      if (currentCount >= rule.max) continue;

      const zone = mapRuntime.zones.find((z) => z.id === rule.zoneId);
      if (!zone) continue;

      const archetype = archetypeRegistry.get(rule.kind);
      const pos = randomPointInZone(zone);

      spawnEntity(world, archetype, componentRegistry, { x: pos.x, y: pos.y, mapId });
      timer.lastSpawnTime = now;
    }
  }

  return world;
}
