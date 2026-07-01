import type { GameWorld, System } from "framework/world";
import { createGameWorld } from "framework/world";
import { buildSystems } from "framework/systems/systemRegistry";
import { buildMapRuntime } from "framework/map/buildRuntime";
import { getMapSourceFromConfig } from "config/map";
import { spawnEntity } from "framework/entities/spawn";
import { getRegistries } from "framework/bootstrap";
import type { GameDefinition } from "framework/config/schema/GameDefinitionSchema";

export interface GameInstance {
  world: GameWorld;
  systems: System[];
  step(dtMs: number): void;
  spawnInitialEntities(): void;
}

export function createGameInstance(gameDef: GameDefinition): GameInstance {
  const { componentRegistry, systemRegistry, archetypeRegistry } = getRegistries();

  const fixedDtMs = Math.max(1, Math.floor(1000 / gameDef.tickRate));
  const world = createGameWorld(fixedDtMs);

  const systems = buildSystems(world, gameDef.systems ?? [], systemRegistry);

  const mapBuilt = buildMapRuntime(getMapSourceFromConfig());
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
