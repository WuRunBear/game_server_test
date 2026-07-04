import { createWorld } from "bitecs";

import { createMetrics, type Metrics } from "framework/metrics";
import { createLogger, type Logger } from "framework/utils/logger";
import type { MapRuntime } from "framework/map";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { SystemRegistry } from "framework/systems/systemRegistry";
import type { ActionRegistry } from "framework/ai/actionRegistry";
import type { ArchetypeRegistry } from "framework/entities/archetypeRegistry";
import type { GeneratorRegistry } from "framework/map/generatorRegistry";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";

export type EntityId = number;
export type Tick = number;

export interface GameTime {
  tick: Tick;
  dtMs: number;
  fixedDtMs: number;
}

export type GameWorld = ReturnType<typeof createWorld> & {
  time: GameTime;
  metrics: Metrics;
  logger: Logger;
  map?: MapRuntime;

  gameDef: LoadedGameDefinition;
  archetypes: ArchetypeRegistry;
  systems_registry: SystemRegistry;
  actions: ActionRegistry;
  generators: GeneratorRegistry;
  components_registry: ComponentRegistry;

  systemRuntimes: Map<string, unknown>;
  nextNetworkId: number;
};

export type System = (world: GameWorld) => GameWorld;

export function createGameWorld(fixedDtMs: number): GameWorld {
  const world = createWorld({
    time: {
      tick: 0,
      dtMs: fixedDtMs,
      fixedDtMs,
    },
    metrics: createMetrics(),
    logger: createLogger("world"),
    systemRuntimes: new Map(),
    nextNetworkId: 1,
  }) as GameWorld;

  return world;
}
