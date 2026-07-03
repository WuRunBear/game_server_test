import { createWorld } from "bitecs";

import { createMetrics, type Metrics } from "framework/metrics";
import { createLogger, type Logger } from "framework/utils/logger";
import type { MapRuntime } from "framework/map";

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

  gameDef: Record<string, unknown>;
  archetypes: Record<string, unknown>;
  systems_registry: Record<string, unknown>;
  actions: Record<string, unknown>;
  generators: Record<string, unknown>;
  components_registry: Record<string, unknown>;

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
