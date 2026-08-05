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

/** 昼夜相位编号（通用机制词，语义由 game/ 配置约定）。 */
export const PHASE_DAY = 0;
export const PHASE_NIGHT = 1;

/** world 级时间状态（非 bitecs 组件，挂在 world.time 上）。 */
export interface TimeOfDay {
  /** 当日小时（0-24 连续浮点，跨日取模）。 */
  hour: number;
  /** 相位编号（PHASE_DAY / PHASE_NIGHT）。 */
  phase: number;
}

export interface GameTime {
  tick: Tick;
  dtMs: number;
  fixedDtMs: number;
  /** 昼夜状态，由 dayNightCycleSystem 推进（缺省配置时保持初始值）。 */
  timeOfDay: TimeOfDay;
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
      timeOfDay: { hour: 8, phase: PHASE_DAY },
    },
    metrics: createMetrics(),
    logger: createLogger("world"),
    systemRuntimes: new Map(),
    nextNetworkId: 1,
  }) as GameWorld;

  return world;
}
