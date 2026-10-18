/**
 * framework 公共导出面（barrel）。
 *
 * 所有对外能力（工具、注册表、引导、仿真、持久化、系统、事件、配置模型）
 * 在此统一 re-export；游戏代码与工具代码只经此入口（或具体子路径）使用框架，
 * 从而维持「tools/src → framework」的单向依赖。新增框架模块时在此补充导出。
 */
export { createLogger, type Logger } from "framework/utils/logger";
export { createMetrics, recordTick, type Metrics } from "framework/metrics";
export { createGameWorld, type GameWorld, type EntityId, type Tick, type System, type GameTime, type TimeOfDay, type EnvironmentState, PHASE_DAY, PHASE_NIGHT } from "framework/world";

// 新地图系统公共面（geometry 数据层 + generate 生成层 + 几何导出）
export type { MapGeometry, MapGeometryGrid, RegionMeta } from "map/geometry/types";
export { serializeGeometry, type SerializedMapGeometry } from "map/geometry/snapshot";
export { buildMapGeometry, validateMapGeometry } from "map/generate";
export { exportGeometryArtifacts, type GeometryExportOptions, type TilePalette } from "framework/map/exportGenerated";

export { createComponentRegistry, type ComponentRegistry, type ComponentEntry } from "framework/components/componentRegistry";
export {
  assertStrictConfigSchema,
  type RegistrationMetadata,
  type RegistrationEntry,
} from "framework/registryMetadata";
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

// 类型化事件总线（tick 内排队、固定阶段 drain 消费）
export {
  queueEvent, drainEvents,
  type QueuedEvent, type TypedEventPayloads, type TypedEventName,
} from "framework/simulation/events/eventBus";

// 效果系统（注册表 + 内置效果）
export {
  registerEffect, getEffect, hasEffect, listEffects, listEffectEntries, applyEffectSpecs, positionOfEntity, parseEffectSpec,
  type EffectContext, type EffectExecutor, type EffectSpec, type EffectEntry,
} from "framework/simulation/effects/effectRegistry";
export { registerBuiltinEffects } from "framework/simulation/effects/builtinEffects";

// 定时器（AoS 组件 + 系统）
export {
  ExpiresAt, Interval, setExpiresAt, setIntervalTimer,
  type ExpiresAtEntry, type IntervalEntry,
} from "framework/simulation/timer/timer";
export { timerSystem } from "framework/simulation/timer/timerSystem";
// 实体持久寿命（SoA，绝对到期 tick，随实体入档）
export { Lifetime } from "framework/components/lifetime";

// 修饰符（AoS 组件 + 属性合成 + 过期清理系统）
export {
  Modifiers, addModifier, computeStat, computeNumericStat,
  STAT_MOVE_SPEED, STAT_ATTACK, STAT_DEFENSE,
  type ModifierEntry, type ModifierSet,
} from "framework/simulation/modifiers/modifiers";
export { modifierSystem } from "framework/simulation/modifiers/modifierSystem";

// 触发器（AoS 组件 + 注册表 + 系统）
export { Triggers, initTriggers, type TriggerEntry } from "framework/simulation/triggers/triggers";
export {
  registerTrigger, getTrigger, hasTrigger, listTriggers, listTriggerEntries, registerBuiltinTriggers,
  type TriggerContext, type TriggerEvaluator, type TriggerEvaluatorEntry,
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
export { projectileSystem, spawnProjectile, throwWeapon } from "framework/systems/gameplay/projectileSystem";
// 可开合通行口（组件 + 状态助手）
export { Passage, PASSAGE_CLOSED, PASSAGE_OPEN, isPassageOpen, togglePassage } from "framework/components/passage";

export { serializeWorld, restoreWorld } from "framework/persistence/worldSerializer";
export { createFileRepository } from "framework/persistence/fileRepository";
export type { Repository, WorldRecord, SerializedEntity, SerializedCraftingJob } from "framework/repository";

export { dayNightCycleSystem } from "framework/systems/gameplay/dayNightCycleSystem";
export { environmentSystem } from "framework/systems/gameplay/environmentSystem";
export { portalSystem } from "framework/systems/gameplay/portalSystem";
export { movePlayerToMap } from "framework/map/switchMap";
export { registerSpawnCondition, registerParameterizedSpawnCondition, getSpawnCondition, hasSpawnCondition, listSpawnConditions, registerBuiltinSpawnConditions, SPAWN_CONDITION_ARG_SEPARATOR, type SpawnCondition, type ParameterizedSpawnCondition, type SpawnConditionEntry } from "framework/systems/gameplay/spawnConditions";

// WorldClock 相位/环境派生（tick 纯函数；不含累积状态）
export {
  environmentAt, phaseAt, weatherAt, weatherSlotAt, cycleTicks, resolveModifiers,
  getEnvironmentRule, NEUTRAL_ENVIRONMENT,
  deriveEffectiveGround, effectiveGroundAt, effectiveGroundAtPixel, effectiveGroundViewAt,
  groundCoverageHash,
  type EnvironmentView, type PhaseView, type TileContext, type GroundDerivationFn,
  type EffectiveGroundView, type GroundQuery,
} from "framework/simulation/worldClock";
// 昼夜时钟（hour/phase 同为 tick 纯函数派生，与 WorldClock 同源）
export {
  DEFAULT_DAYNIGHT_START_HOUR, dayTicks, getDayNightRule, phaseOfHour,
  syncTimeOfDay, tickRateOf, timeOfDayAt, timeOfDayOf,
} from "framework/simulation/worldClock/dayNight";
export { registerPopulationModel, getPopulationModel, listPopulationModels, registerBuiltinPopulationModels, type PopulationModel, type PopulationModelContext } from "framework/map/evolution/populationModels";
export { sameLevelDistance, isGameplayReachable, type GameplayEndpoint, type GameplayLosCheck } from "framework/utils/gameplayDistance";
export { collectBuiltStructures, collectBuiltStructuresByMap, collectConnectorLookup, floodSameLevel, getBuiltStructuresEpoch, bumpBuiltStructuresEpoch, emptyBuiltStructuresIndex, type BuiltStructuresIndex, type StructureConnector } from "framework/map/runtime/builtStructures";
export { setGround, setWalkable, setLevel, drainDirtyTiles, terrainBaselineOf, getTerrainEpoch, type TerrainChangeRecord } from "framework/map/runtime/terrainWriteback";
export { spaceExposureAt, isIndoors, entitySpaceExposure, entityIsIndoors, type SpaceExposure, type IndoorsOptions, DEFAULT_MAX_ENCLOSED_AREA } from "framework/map/runtime/indoors";
export { placeEntity } from "framework/systems/gameplay/placeableSystem";
export { deconstructEntity } from "framework/systems/gameplay/deconstructSystem";
export { startDialogue, advanceDialogue, applyDialogueEffect, END_DIALOGUE } from "framework/systems/gameplay/dialogueSystem";
export { acceptQuest, submitQuest, createQuestSystem, questSystem } from "framework/systems/gameplay/questSystem";
export { addRelation, getRelation } from "framework/systems/gameplay/relation";
export { emitEvent, consumeEvents, type GameEvent } from "framework/events/gameEvents";
export { overlapsAnyEntity, overlapsMapBlocked, overlapsOccupiedGrid, snapToGrid } from "framework/utils/placement";

export { GameDefinitionSchema, WorldTileSchema, WorldSchema, type GameDefinition, type WorldTile, type WorldConfig, type LoadedGameDefinition, type BehaviorDefinition, type SystemEnableEntry, type NetSyncField } from "framework/config/schema/GameDefinitionSchema";
export { normalizeTileUnits } from "framework/config/tileUnits";
export { ItemKindSchema, type ItemKindSpec, type ConsumeEffect, type ItemEffectSpec, type EquipEffect, type PlaceEffect, type ThrowProfile } from "framework/config/schema/ItemKindSchema";
export { registerRuleSchema, getRuleSchema, hasRuleSchema, registerBuiltinRuleSchemas } from "framework/config/schema/ruleSchemas";
export { CombatRuleSchema, NeedsRuleSchema, CraftingRuleSchema, DayNightRuleSchema, EnvironmentRuleSchema, ServerRuleSchema, RespawnRuleSchema, RaidRuleSchema, DisasterRuleSchema, WildfireRuleSchema, StormRuleSchema, DialogueRuleSchema, DialogueTradeRuleSchema, DialogueSupplyDemandRuleSchema, FactionDefinitionSchema, FactionRuleSchema, AchievementRewardSchema, AchievementDefinitionSchema, AchievementRuleSchema, EnvironmentModifierSchema, EnvironmentPhaseSchema, PhaseWeatherOptionSchema, GroundOverrideSchema, PlaceRuleSchema, FallDamageRuleSchema, ProgressionRuleSchema, ProgressionCurveSchema, ProgressionSkillRuleSchema, type CombatRule, type NeedsRule, type CraftingRule, type CraftingRecipe, type DayNightRule, type EnvironmentRule, type EnvironmentPhase, type EnvironmentModifier, type PhaseWeatherOption, type GroundOverride, type ServerRule, type RespawnRule, type RaidRule, type DisasterRule, type WildfireRule, type StormRule, type DialogueRule, type DialogueTradeRule, type DialogueSupplyDemandRule, type FactionDefinition, type FactionRule, type AchievementReward, type AchievementDefinition, type AchievementRule, type PlaceRule, type FallDamageRule, type ProgressionRule } from "framework/config/schema/RuleSchema";
export { FACTION_RELATION_PREFIX, factionRelationKey, getFactionRule, getFactionDefinition, factionOfNpcKind, getFactionRep, addFactionRep, creditFactionForNpcKind, creditTradeFactionRep } from "framework/systems/gameplay/factions";
export { DEFAULT_TRADE_VOLUME_PREFIX, tradeVolumeKey, tradeVolumeTickKey, tradeVolumePrefix, decayedTradeVolume, recordTradeVolume, tradeUnitPrice, type TradePriceInput } from "framework/systems/gameplay/pricing";
export { ACHIEVEMENT_PROGRESS_PREFIX, ACHIEVEMENT_PENDING_PREFIX, DEFAULT_ACHIEVEMENT_CHECK_INTERVAL, achievementProgressKey, achievementPendingKey, isAchievementUnlocked, getAchievementRule, createAchievementSystem, achievementSystem, type AchievementSystemConfig } from "framework/systems/gameplay/achievementSystem";
export { setRelation } from "framework/systems/gameplay/relation";
export { Progression, initProgression, type ProgressionState, type SkillProgress } from "framework/components/progression";
export { addXp, levelForXp, getSkillBonuses, getSkillAdd, getSkillMultiplier, awardHarvestXp, progressionSystem, getProgressionRules, parseProgressionRules, validateProgressionConfig, validateProgressionRules, DEFAULT_PROGRESSION_CURVE, type ProgressionCurve, type SkillBonusRule, type ProgressionRules, type SkillBonuses, type XpGainResult } from "framework/systems/gameplay/progression";
export { Achievements, initAchievements, markAchievementUnlocked, type AchievementsState } from "framework/components/achievements";
export { isCriticalRoll, applyCritAndResist, clampDamageResist, normalizeCritMultiplier, MAX_DAMAGE_RESIST, DEFAULT_CRIT_MULTIPLIER, CRIT_RNG_CHANNEL } from "framework/systems/gameplay/damageFormula";
export { getWeaponCombatProfile, getArmorDamageResist, type WeaponCombatProfile } from "framework/systems/gameplay/equipmentSystem";
export { STAT_GATHER_MULT } from "framework/simulation/modifiers/modifiers";
export { createDisasterSystem, disasterSystem } from "framework/systems/gameplay/disasterSystem";
export { craftRecipe, stepCraftingJobs, cancelCrafting, craftingProgressOf, validateCraftingRules, stationsInRange, craftingStationRange, serializeCraftingJobs, restoreCraftingJobs, type PendingCraft } from "framework/systems/gameplay/craftingSystem";
export { stepFuelBurn, refuelStation, validateFuelRules, resolveFuelConfig, fastForwardFuelBurn, type FuelConfig } from "framework/systems/gameplay/fuelSystem";
export { findPath, findPathWithStats, lineOfSightClear, DEFAULT_MAX_NODES, type PathTile, type AStarResult, type PathfindingBlockers } from "framework/ai/pathfinding/astar";
export { createDefaultPathfindingConfig, DEFAULT_PATHFINDING_CONFIG, parsePathfindingConfigValue, resolvePathfindingConfig, type PathfindingConfig } from "framework/ai/pathfinding/config";

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
  listRegisteredComponentEntries,
  listRegisteredMapGenerators,
  listRegisteredRuleModules,
  validateGameDefinition,
  type RuleModule,
  type RuleModuleEntry,
} from "framework/api";
