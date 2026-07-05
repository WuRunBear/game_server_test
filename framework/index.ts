export { createLogger, type Logger } from "framework/utils/logger";
export { clampMs } from "framework/utils/timer";
export { createMetrics, recordTick, type Metrics } from "framework/metrics";
export { createGameWorld, type GameWorld, type EntityId, type Tick, type System, type GameTime } from "framework/world";

export { createComponentRegistry, type ComponentRegistry } from "framework/components/componentRegistry";
export { createSystemRegistry, type SystemRegistry, type SystemSpec, buildSystems } from "framework/systems/systemRegistry";
export { createActionRegistry, type ActionRegistry, type ActionFactory, type ActionEntry } from "framework/ai/actionRegistry";
export { createArchetypeRegistry, type ArchetypeRegistry, type ArchetypeSpec } from "framework/entities/archetypeRegistry";
export { spawnEntity, type SpawnOverrides } from "framework/entities/spawn";

export { createGameInstance, type GameInstance } from "framework/bootstrap/GameInstance";
export { loadGameDefinition, createDefaultGameDefinition } from "framework/bootstrap/loadGameDefinition";
export { bootstrapFramework, getRegistries, type FrameworkRegistries } from "framework/bootstrap";

export { runHeadless, type HeadlessHostOptions } from "framework/net/headless/HeadlessHost";

export { GameDefinitionSchema, type GameDefinition, type LoadedGameDefinition, type BehaviorDefinition, type SpawnRule, type SystemEnableEntry, type NetSyncField } from "framework/config/schema/GameDefinitionSchema";

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
