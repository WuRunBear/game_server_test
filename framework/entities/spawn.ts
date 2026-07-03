import { addComponent, addEntity } from "bitecs";
import type { EntityId, GameWorld } from "framework/world";
import type { ArchetypeSpec } from "framework/entities/archetypeRegistry";
import type { ComponentRegistry } from "framework/components/componentRegistry";

import { Transform } from "framework/components/transform";
import { NetworkId } from "framework/components/network";
import { Player, NPC, Enemy, Item } from "framework/components/tags";
import { Team } from "framework/components/combat";

const TAG_MAP: Record<string, unknown> = { Player, NPC, Enemy, Item };

export interface SpawnOverrides {
  x?: number;
  y?: number;
  [key: string]: unknown;
}

export function spawnEntity(
  world: GameWorld,
  archetype: ArchetypeSpec,
  componentRegistry: ComponentRegistry,
  overrides?: SpawnOverrides,
): EntityId {
  const eid = addEntity(world);

  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);

  for (const [compName, compValues] of Object.entries(archetype.components)) {
    const comp = componentRegistry.get(compName);
    addComponent(world, eid, comp);
    for (const [field, value] of Object.entries(compValues)) {
      const compObj = comp as Record<string, Record<number, unknown>>;
      if (compObj[field] !== undefined) {
        compObj[field][eid] = value;
      }
    }
  }

  Transform.x[eid] = overrides?.x ?? 0;
  Transform.y[eid] = overrides?.y ?? 0;

  if (archetype.tags) {
    for (const tag of archetype.tags) {
      const tagComp = TAG_MAP[tag];
      if (tagComp) {
        addComponent(world, eid, tagComp);
      }
    }
  }

  if (archetype.team !== undefined) {
    addComponent(world, eid, Team);
    Team.id[eid] = archetype.team;
  }

  NetworkId.value[eid] = world.nextNetworkId++;

  return eid;
}
