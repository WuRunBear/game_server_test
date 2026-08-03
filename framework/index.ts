export { createLogger, type Logger } from "framework/utils/logger";
export { clampMs } from "framework/utils/timer";
export { createMetrics, recordTick, type Metrics } from "framework/metrics";
export { createGameWorld, type GameWorld, type EntityId, type Tick, type System, type GameTime } from "framework/world";
export type { MapRuntime, MapSource, MapGrid, MapZone, MapSpawns, Vec2 } from "framework/map/types";

export { createComponentRegistry, type ComponentRegistry } from "framework/components/componentRegistry";
export { createSystemRegistry, type SystemRegistry, type SystemSpec, buildSystems } from "framework/systems/systemRegistry";
export { createActionRegistry, type ActionRegistry, type ActionFactory, type ActionEntry } from "framework/ai/actionRegistry";
export { createArchetypeRegistry, type ArchetypeRegistry, type ArchetypeSpec } from "framework/entities/archetypeRegistry";
export { createGeneratorRegistry, type GeneratorRegistry, type GeneratorEntry, type MapGenerator } from "framework/map/generatorRegistry";
export { spawnEntity, type SpawnOverrides } from "framework/entities/spawn";

export { createGameInstance, type GameInstance } from "framework/bootstrap/GameInstance";
export { loadGameDefinition, createDefaultGameDefinition } from "framework/bootstrap/loadGameDefinition";
export { bootstrapFramework, getRegistries, type FrameworkRegistries } from "framework/bootstrap";

export { runHeadless, type HeadlessHostOptions } from "framework/net/headless/HeadlessHost";

export { createGameSimulation, GameSimulation } from "framework/simulation/GameSimulation";
export type { SimulationPort } from "framework/simulation/SimulationPort";
export type {
  PlayerInput, PlayerJoinResult, TickSnapshot, TickResult, DebugSnapshotOptions, PlayerCommand, EntitySnapshot,
} from "framework/simulation/types";
export { registerAosSyncAdapter, getAosSyncAdapter, type AosSyncAdapter, type AosSyncOutput } from "framework/simulation/aosSyncAdapters";

export { GameDefinitionSchema, type GameDefinition, type LoadedGameDefinition, type BehaviorDefinition, type SpawnRule, type SystemEnableEntry, type NetSyncField } from "framework/config/schema/GameDefinitionSchema";
export { ItemKindSchema, type ItemKindSpec, type ConsumeEffect } from "framework/config/schema/ItemKindSchema";
export { registerRuleSchema, getRuleSchema, hasRuleSchema, registerBuiltinRuleSchemas } from "framework/config/schema/ruleSchemas";

export {
  registerSystem,
  registerComponent,
  registerArchetype,
  registerAction,
  registerGenerator,
  registerRuleModule,
  getRuleModule,
  listRegisteredSystems,
  listRegisteredArchetypes,
  listRegisteredActions,
  listRegisteredComponents,
  listRegisteredGenerators,
  validateGameDefinition,
  buildMapRuntime,
  exportMapRuntime,
  type RuleModule,
} from "framework/api";
