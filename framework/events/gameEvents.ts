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
  type: string;
  data: Record<string, unknown>;
}

/** 发射事件（追加到本帧事件队列）。 */
export function emitEvent(world: GameWorld, type: string, data: Record<string, unknown>): void {
  world.runtimeEvents.push({ type, data });
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
