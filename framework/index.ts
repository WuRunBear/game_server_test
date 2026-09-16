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

// 新地图系统公共面（geometry 数据层 + generate 生成层 + 几何导出）
export type { MapGeometry, MapGeometryGrid, RegionMeta } from "map/geometry/types";
export { serializeGeometry, type SerializedMapGeometry } from "map/geometry/snapshot";
export { buildMapGeometry, validateMapGeometry } from "map/generate";
export { exportGeometryArtifacts, type GeometryExportOptions, type TilePalette } from "framework/map/exportGenerated";

export { createComponentRegistry, type ComponentRegistry } from "framework/components/componentRegistry";
export { createSystemRegistry, type SystemRegistry, type SystemSpec, buildSystems } from "framework/systems/systemRegistry";
export { createActionRegistry, type ActionRegistry, type ActionFactory, type ActionEntry } from "framework/ai/actionRegistry";
export { createArchetypeRegistry, type ArchetypeRegistry, type ArchetypeSpec } from "framework/entities/archetypeRegistry";
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

// 类型化事件总线（tick 内排队、固定阶段消费）
export {
  queueEvent, subscribeEvent, drainEvents, dispatchEvents,
  type QueuedEvent, type TypedEventPayloads, type TypedEventName, type EventHandler,
} from "framework/simulation/events/eventBus";

// 效果系统（注册表 + 内置效果）
export {
  registerEffect, getEffect, hasEffect, listEffects, applyEffectSpecs, positionOfEntity,
  type EffectContext, type EffectExecutor, type EffectSpec,
} from "framework/simulation/effects/effectRegistry";
export { registerBuiltinEffects } from "framework/simulation/effects/builtinEffects";

// 定时器（AoS 组件 + 系统）
export {
  ExpiresAt, Interval, setExpiresAt, setIntervalTimer, clearTimers,
  type ExpiresAtEntry, type IntervalEntry,
} from "framework/simulation/timer/timer";
export { timerSystem } from "framework/simulation/timer/timerSystem";

// 修饰符（AoS 组件 + 属性合成）
export { Modifiers, addModifier, computeStat, type ModifierEntry, type ModifierSet } from "framework/simulation/modifiers/modifiers";

// 触发器（AoS 组件 + 注册表 + 系统）
export { Triggers, addTrigger, type TriggerEntry } from "framework/simulation/triggers/triggers";
export {
  registerTrigger, getTrigger, hasTrigger, listTriggers, registerBuiltinTriggers,
  type TriggerContext, type TriggerEvaluator,
} from "framework/simulation/triggers/triggerRegistry";
export { triggerSystem } from "framework/simulation/triggers/triggerSystem";

// 容器层（统一容器接口 + 转移原语）
export {
  queryContainer, insertContainer, removeContainer,
  transferContainer, swapContainers, snapshotContainer, restoreContainer,
  type ContainerKind, type ContainerRef, type ContainerSnapshot,
} from "framework/economy/container";

// 交易（多方结算 + 报价会话）
export {
  settle,
  type TransferAmount, type SettlePartyTerms, type SettleTerms,
} from "framework/economy/settle";
export {
  openOffer, acceptOffer, cancelOffer, getOffer, pruneExpiredOffers,
  type OfferSession, type OfferStatus, type OpenOfferOptions,
} from "framework/economy/offer";

// 伤害公式（combat 与 damage 效果共用）
export { computeStandardDamage } from "framework/systems/gameplay/damageFormula";

// 投射物（组件 + 系统 + 生成原子）
export { projectileSystem, spawnProjectile } from "framework/systems/gameplay/projectileSystem";

export { serializeWorld, restoreWorld } from "framework/persistence/worldSerializer";
export { createFileRepository } from "framework/persistence/fileRepository";
export type { Repository, WorldRecord, SerializedEntity } from "framework/repository";

export { dayNightCycleSystem } from "framework/systems/gameplay/dayNightCycleSystem";
export { portalSystem } from "framework/systems/gameplay/portalSystem";
export { movePlayerToMap } from "framework/map/switchMap";
export { registerSpawnCondition, getSpawnCondition, hasSpawnCondition, registerBuiltinSpawnConditions, type SpawnCondition } from "framework/systems/gameplay/spawnConditions";
export { placeEntity } from "framework/systems/gameplay/placeableSystem";
export { deconstructEntity } from "framework/systems/gameplay/deconstructSystem";
export { startDialogue, advanceDialogue, applyDialogueEffect, END_DIALOGUE } from "framework/systems/gameplay/dialogueSystem";
export { acceptQuest, submitQuest, createQuestSystem, questSystem } from "framework/systems/gameplay/questSystem";
export { addRelation, getRelation } from "framework/systems/gameplay/relation";
export { emitEvent, consumeEvents, type GameEvent } from "framework/events/gameEvents";
export { overlapsAnyEntity, overlapsMapBlocked, overlapsOccupiedGrid, snapToGrid } from "framework/utils/placement";

export { GameDefinitionSchema, type GameDefinition, type LoadedGameDefinition, type BehaviorDefinition, type SystemEnableEntry, type NetSyncField } from "framework/config/schema/GameDefinitionSchema";
export { ItemKindSchema, type ItemKindSpec, type ConsumeEffect, type EquipEffect, type PlaceEffect } from "framework/config/schema/ItemKindSchema";
export { registerRuleSchema, getRuleSchema, hasRuleSchema, registerBuiltinRuleSchemas } from "framework/config/schema/ruleSchemas";
export { CombatRuleSchema, NeedsRuleSchema, CraftingRuleSchema, DayNightRuleSchema, ServerRuleSchema, type CombatRule, type NeedsRule, type CraftingRule, type CraftingRecipe, type DayNightRule, type ServerRule } from "framework/config/schema/RuleSchema";

export {
  registerSystem,
  registerComponent,
  registerArchetype,
  registerAction,
  registerRuleModule,
  getRuleModule,
  listRegisteredSystems,
  listRegisteredArchetypes,
  listRegisteredActions,
  listRegisteredComponents,
  listRegisteredMapGenerators,
  validateGameDefinition,
  type RuleModule,
} from "framework/api";
