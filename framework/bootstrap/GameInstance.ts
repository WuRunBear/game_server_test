import type { GameWorld, System } from "framework/world";
import { createGameWorld } from "framework/world";
import { buildSystems } from "framework/systems/systemRegistry";
import { buildMapRuntime } from "framework/map/buildRuntime";
import { spawnEntity } from "framework/entities/spawn";
import { getRegistries } from "framework/bootstrap";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";

export interface GameInstance {
  world: GameWorld;
  systems: System[];
  step(dtMs: number): void;
  spawnInitialEntities(): void;
}

export function createGameInstance(gameDef: LoadedGameDefinition): GameInstance {
  const { componentRegistry, systemRegistry, archetypeRegistry, actionRegistry, generatorRegistry } = getRegistries();

  const fixedDtMs = Math.max(1, Math.floor(1000 / gameDef.tickRate));
  const world = createGameWorld(fixedDtMs);

  world.gameDef = gameDef;
  world.components_registry = componentRegistry;
  world.systems_registry = systemRegistry;
  world.archetypes = archetypeRegistry;
  world.actions = actionRegistry;
  world.generators = generatorRegistry;

  for (const entity of gameDef.resolvedEntities) {
    try {
      archetypeRegistry.register(entity);
    } catch {
      // 实体已在默认原型中注册（如 player/villager），JSON 版本以默认版本为准
    }
  }

  const systems = buildSystems(world, gameDef.systems ?? [], systemRegistry);

  const mapBuilt = gameDef.resolvedMapSource
    ? buildMapRuntime(gameDef.resolvedMapSource)
    : undefined;
  world.map = mapBuilt;

  const instance: GameInstance = {
    world,
    systems,

    step(dtMs) {
      world.time.tick += 1;
      world.time.dtMs = dtMs || fixedDtMs;

      for (const system of systems) {
        system(world);
      }
    },

    spawnInitialEntities() {
      if (!mapBuilt) return;
      for (const spawn of mapBuilt.spawns.npcs) {
        const archetype = archetypeRegistry.get(spawn.kind);
        spawnEntity(world, archetype, componentRegistry, {
          x: spawn.pos.x,
          y: spawn.pos.y,
        });
      }
    },
  };

  instance.spawnInitialEntities();

  return instance;
}
