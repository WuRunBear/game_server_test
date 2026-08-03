import { addComponent, addEntity } from "bitecs";
import type { EntityId, GameWorld } from "framework/world";
import type { ArchetypeSpec } from "framework/entities/archetypeRegistry";
import type { ComponentRegistry } from "framework/components/componentRegistry";

import { Transform } from "framework/components/transform";
import { NetworkId } from "framework/components/network";
import { Player, NPC, Enemy, Item, Resource } from "framework/components/tags";
import { Team } from "framework/components/combat";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";

const TAG_MAP: Record<string, unknown> = { Player, NPC, Enemy, Item, Resource };

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

  for (const [compName, compConfig] of Object.entries(archetype.components)) {
    const comp = componentRegistry.get(compName);

    // AoS 组件（普通 JS 数组）不走 bitecs 的 addComponent/按字段赋值路径，
    // 改由注册的初始化钩子按 archetype 配置写入 ComponentAoS[eid]。
    // 若未注册钩子则跳过（与历史 SoA-only 行为一致，避免误把数组当 SoA 写）。
    if (Array.isArray(comp)) {
      const initializer = componentRegistry.getAosInitializer(compName);
      if (initializer) {
        initializer(world, eid, compConfig);
      }
      continue;
    }

    addComponent(world, eid, comp);
    const compObj = comp as Record<string, Record<number, unknown>>;
    if (compConfig && typeof compConfig === "object") {
      for (const [field, value] of Object.entries(compConfig as Record<string, unknown>)) {
        if (compObj[field] !== undefined) {
          compObj[field][eid] = value;
        }
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

  setEntityKind(world, eid, archetype.kind);

  return eid;
}
