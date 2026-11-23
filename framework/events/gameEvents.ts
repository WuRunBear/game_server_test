/**
 * 帧内事件总线——系统间的事件传递（无订阅解耦的最小实现）。
 *
 * 语义：事件只在产生它的那一帧有效——系统在 tick 链中 emit，同帧后续系统
 * consume；GameInstance.step 在每帧开头清空残留（未消费事件不跨帧堆积）。
 *
 * 用法（以击杀事件为例）：
 * - 产生方：combatSystem.attackTarget 造成致命一击时 emitEvent(world, "killed", {...})
 * - 消费方：questSystem 在 tick 中 consumeEvents(world, "killed") 统计本帧击杀
 *
 * 游戏无关——事件 type 与 data 字段由各系统约定（如 "killed" 的 victim kind）。
 */
import type { GameWorld } from "world";

export interface GameEvent {
  /** 事件类型标识（如 "killed"），产生方与消费方必须约定一致。 */
  type: string;
  /** 事件载荷（如击杀者/受害者 eid 等），具体字段由各系统约定。 */
  data: Record<string, unknown>;
}

/**
 * 非破坏性 tap：在事件**发射时**旁路观察（不改变 runtimeEvents 的消费语义）。
 *
 * CC-04 用它在 `killed` 上生成客户端 `death` 事件；questSystem/progressionSystem
 * 仍是原有的 consume/peek 消费方，互不影响。
 */
export type GameEventTap = (event: GameEvent) => void;

/** world → tap 集合（模块级 WeakMap，不给 GameWorld 加公共字段）。 */
const tapsByWorld = new WeakMap<GameWorld, Set<GameEventTap>>();

/**
 * 注册帧内事件发射 tap。
 *
 * @returns 取消注册函数（world 生命周期内通常无需调用）
 */
export function tapGameEvents(world: GameWorld, tap: GameEventTap): () => void {
  let taps = tapsByWorld.get(world);
  if (!taps) {
    taps = new Set();
    tapsByWorld.set(world, taps);
  }
  taps.add(tap);
  return () => {
    tapsByWorld.get(world)?.delete(tap);
  };
}

/** 发射事件（追加到本帧事件队列）。 */
export function emitEvent(world: GameWorld, type: string, data: Record<string, unknown>): void {
  const event: GameEvent = { type, data };
  world.runtimeEvents.push(event);

  // 非破坏性旁路观察（tap 抛错不得影响事件生产/消费链）。
  const taps = tapsByWorld.get(world);
  if (taps) {
    for (const tap of taps) {
      try {
        tap(event);
      } catch (err) {
        world.logger.warn("gameEvents tap 执行失败（已忽略）", {
          type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/** 取出本帧指定类型的事件并清空（消费一次；事件不跨帧）。 */
export function consumeEvents(world: GameWorld, type: string): GameEvent[] {
  const found: GameEvent[] = [];
  const rest: GameEvent[] = [];
  for (const evt of world.runtimeEvents) {
    if (evt.type === type) {
      found.push(evt);
    } else {
      rest.push(evt);
    }
  }
  world.runtimeEvents = rest;
  return found;
}
