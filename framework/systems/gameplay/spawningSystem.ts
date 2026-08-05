import { query } from "bitecs";
import { Transform, Kind } from "components";
import type { GameWorld } from "world";
import { spawnEntity } from "framework/entities/spawn";
import type { ArchetypeRegistry } from "framework/entities/archetypeRegistry";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { SpawnRule } from "framework/config/schema/GameDefinitionSchema";
import { hasSpawnCondition, getSpawnCondition } from "framework/systems/gameplay/spawnConditions";
import { pointInPolygon } from "framework/utils/geometry";

interface SpawnTimer {
  lastSpawnTime: number;
  rule: SpawnRule;
}

const SPAWN_KEY = "spawning";
const RANDOM_POINT_MAX_RETRIES = 16;

function getSpawnTimers(world: GameWorld): SpawnTimer[] {
  let timers = world.systemRuntimes.get(SPAWN_KEY) as SpawnTimer[] | undefined;
  if (timers) return timers;
  timers = [];
  world.systemRuntimes.set(SPAWN_KEY, timers);
  return timers;
}

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
