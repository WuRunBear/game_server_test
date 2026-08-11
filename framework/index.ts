/**
 * framework 公共导出面（barrel）。
 *
 * 所有对外能力（工具、注册表、引导、仿真、持久化、系统、事件、配置模型）
 * 在此统一 re-export；游戏代码与工具代码只经此入口（或具体子路径）使用框架，
 * 从而维持「tools/src → framework」的单向依赖。新增框架模块时在此补充导出。
 */
export { createLogger, type Logger } from "framework/utils/logger";
export { clampMs } from "framework/utils/timer";
export { createMetrics, recordTick, type Metrics } from "framework/metrics";
export { createGameWorld, type GameWorld, type EntityId, type Tick, type System, type GameTime, type TimeOfDay, PHASE_DAY, PHASE_NIGHT } from "framework/world";
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
  SimulationOptions,
} from "framework/simulation/types";
export { registerAosSyncAdapter, getAosSyncAdapter, type AosSyncAdapter, type AosSyncOutput } from "framework/simulation/aosSyncAdapters";
export { computeInterest } from "framework/simulation/interest";
export { createInputGuard, type InputGuard } from "framework/simulation/inputValidation";

export { serializeWorld, restoreWorld } from "framework/persistence/worldSerializer";
export { createFileRepository } from "framework/persistence/fileRepository";
export type { Repository, WorldRecord, SerializedEntity } from "framework/repository";

export { dayNightCycleSystem } from "framework/systems/gameplay/dayNightCycleSystem";
export { portalSystem } from "framework/systems/gameplay/portalSystem";
export { setWorldMap, enterMap, spawnInitialNpcs } from "framework/map/switchMap";
export { registerSpawnCondition, getSpawnCondition, hasSpawnCondition, registerBuiltinSpawnConditions, type SpawnCondition } from "framework/systems/gameplay/spawnConditions";
export { placeEntity } from "framework/systems/gameplay/placeableSystem";
export { deconstructEntity } from "framework/systems/gameplay/deconstructSystem";
export { startDialogue, advanceDialogue, applyDialogueEffect, END_DIALOGUE } from "framework/systems/gameplay/dialogueSystem";
export { acceptQuest, submitQuest, createQuestSystem, questSystem } from "framework/systems/gameplay/questSystem";
export { addRelation, getRelation } from "framework/systems/gameplay/relation";
export { emitEvent, consumeEvents, type GameEvent } from "framework/events/gameEvents";
export { overlapsAnyEntity, overlapsMapBlocked, overlapsOccupiedGrid, snapToGrid } from "framework/utils/placement";

export { GameDefinitionSchema, type GameDefinition, type LoadedGameDefinition, type BehaviorDefinition, type SpawnRule, type SystemEnableEntry, type NetSyncField } from "framework/config/schema/GameDefinitionSchema";
export { ItemKindSchema, type ItemKindSpec, type ConsumeEffect, type EquipEffect, type PlaceEffect } from "framework/config/schema/ItemKindSchema";
export { registerRuleSchema, getRuleSchema, hasRuleSchema, registerBuiltinRuleSchemas } from "framework/config/schema/ruleSchemas";
export { CombatRuleSchema, NeedsRuleSchema, CraftingRuleSchema, DayNightRuleSchema, ServerRuleSchema, type CombatRule, type NeedsRule, type CraftingRule, type CraftingRecipe, type DayNightRule, type ServerRule } from "framework/config/schema/RuleSchema";

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
