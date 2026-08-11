import { createWorld } from "bitecs";

import { createMetrics, type Metrics } from "framework/metrics";
import { createLogger, type Logger } from "framework/utils/logger";
import type { MapRuntime } from "framework/map";
import type { GameEvent } from "framework/events/gameEvents";
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
  /** 已推进的逻辑帧号（每 tick +1）。 */
  tick: Tick;
  /** 本帧实际步进时长（毫秒），由 GameInstance.step 计算并钳制后写入。 */
  dtMs: number;
  /** 固定步长（毫秒），来自 tickRate；dtMs 异常（0/NaN/负数/过大）时的回退值。 */
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
  /** 本帧事件队列（帧内事件总线，见 framework/events/gameEvents.ts）。 */
  runtimeEvents: GameEvent[];
};

/**
 * 系统函数签名：接收并返回同一个 world。
 * 系统按配置拓扑序逐个调用，前一个系统的输出是后一个的输入（链式组合）。
 */
export type System = (world: GameWorld) => GameWorld;

/**
 * 创建空的 GameWorld（仅挂时间/指标/日志/各注册表等基础设施，不含实体）。
 *
 * @param fixedDtMs 固定步长（毫秒），与 gameDef.tickRate 对应
 * @returns 初始 world：tick=0、dtMs=fixedDtMs、从 8 时白天开始、nextNetworkId=1、空事件队列
 */
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
    runtimeEvents: [],
  }) as GameWorld;

  return world;
}
