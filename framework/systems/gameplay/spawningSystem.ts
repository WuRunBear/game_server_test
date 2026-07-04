import { query, hasComponent } from "bitecs";
import { NPC } from "components";
import type { GameWorld, EntityId } from "world";
import { spawnEntity } from "framework/entities/spawn";
import type { ArchetypeRegistry } from "framework/entities/archetypeRegistry";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { SpawnRule } from "framework/config/schema/GameDefinitionSchema";

interface SpawnTimer {
  lastSpawnTime: number;
  rule: SpawnRule;
}

const SPAWN_KEY = "spawning";

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

  let count = 0;
  for (const eid of query(world, [NPC])) {
    if (!hasComponent(world, eid, NPC)) continue;

    const found = world.gameDef.resolvedEntities.find((e) => e.kind === kind);
    if (!found) continue;

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
