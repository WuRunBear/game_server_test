/**
 * 类型化事件总线——tick 内排队、固定阶段消费的系统间事件通道。
 *
 * 与 framework/events/gameEvents.ts（帧内轻量事件：emit/consume 清空式）互补：
 * - gameEvents：系统在 tick 链内 emit + consume，无订阅者概念，事件不跨帧；
 * - 本模块：事件名 → 载荷类型化的队列，由系统在**固定阶段**显式消费
 *   （不自动派发，保持系统拓扑确定性）； GameInstance.step 帧首清空残留，
 *   事件只在产生它的那一 tick 有效。
 *
 * 消费方式两种（二选一，同一 tick 内不要混用）：
 * - drainEvents：整体取出队列自行处理（triggerSystem 用它做声明式触发器求值）；
 * - dispatchEvents：按 FIFO 取出并逐事件调用订阅者（subscribeEvent 注册）。
 *
 * 游戏无关——事件名与载荷结构由 TypedEventPayloads 声明（interface merging 可扩展）。
 */
import type { GameWorld } from "framework/world";

/**
 * 类型化事件载荷表：事件名 → 载荷结构。
 *
 * 命名约定：触发器求值器名 = 事件名（triggerRegistry 按 on-* 名注册）。
 * 预留事件（on-hit/on-death/on-region-*）的产生方接线在配方切片补齐。
 */
export interface TypedEventPayloads {
  /** 定时器触发（timerSystem 入队；phase 区分一次性到期/周期触发）。 */
  "on-timer": { eid: number; phase: "expired" | "interval" };
  /** 玩家命令执行成功（GameSimulation 缓存、下一 tick 系统阶段前入队）。 */
  "on-command": { eid: number; type: string };
  /** 投射物接触实体（projectileSystem 入队；eid=投射物主人，target=被接触实体）。 */
  "on-contact": { eid: number; target: number; x: number; y: number };
  /** 攻击命中（combat 接线预留，配方切片消费）。 */
  "on-hit": { eid: number; attacker: number; target: number };
  /** 实体死亡（death 接线预留）。 */
  "on-death": { eid: number; kind: string };
  /** 进入区域（region 接线预留）。 */
  "on-region-enter": { eid: number; region: string };
  /** 离开区域（region 接线预留）。 */
  "on-region-clear": { eid: number; region: string };
}

/** 类型化事件名（TypedEventPayloads 的键）。 */
export type TypedEventName = keyof TypedEventPayloads & string;

/** 按事件名取载荷类型。 */
export type TypedEventPayload<N extends TypedEventName> = TypedEventPayloads[N];

/** 队列中的事件（派发前的暂存形态）。 */
export interface QueuedEvent {
  /** 事件名。 */
  name: string;
  /** 事件载荷。 */
  payload: unknown;
}

/** 事件处理器签名：载荷 + world（处理器可据此入队新事件）。 */
export type EventHandler = (payload: unknown, world: GameWorld) => void;

/** 事件总线结构（挂在 world.eventBus 上，per-world 实例）。 */
export interface EventBus {
  /** 本 tick 待消费队列（FIFO）。 */
  queue: QueuedEvent[];
  /** 订阅表：事件名 → 处理器列表。 */
  handlers: Map<string, EventHandler[]>;
}

/** 创建空事件总线（帧首由 GameInstance.step 清空 queue）。 */
export function createEventBus(): EventBus {
  return { queue: [], handlers: new Map() };
}

/**
 * 入队一个类型化事件（追加到本 tick 队列尾部）。
 * 载荷结构由 TypedEventPayloads 按事件名静态约束。
 */
export function queueEvent<N extends TypedEventName>(
  world: GameWorld,
  name: N,
  payload: TypedEventPayload<N>,
): void {
  world.eventBus.queue.push({ name, payload });
}

/**
 * 订阅事件（dispatchEvents 消费路径）。
 * @returns 取消订阅函数
 */
export function subscribeEvent(world: GameWorld, name: string, handler: EventHandler): () => void {
  const list = world.eventBus.handlers.get(name) ?? [];
  list.push(handler);
  world.eventBus.handlers.set(name, list);
  return () => {
    const current = world.eventBus.handlers.get(name);
    if (!current) return;
    const index = current.indexOf(handler);
    if (index >= 0) current.splice(index, 1);
  };
}

/**
 * 取出并清空当前队列（清空式消费；由固定阶段的系统调用）。
 * @returns FIFO 顺序的事件数组（消费方持有，总线队列已清空）
 */
export function drainEvents(world: GameWorld): QueuedEvent[] {
  const events = world.eventBus.queue;
  world.eventBus.queue = [];
  return events;
}

/**
 * 派发：按 FIFO 取出队列并逐事件调用订阅者（订阅顺序即调用顺序）。
 * 无订阅者的事件自然丢弃；处理器抛错不中断后续派发（错误隔离交由
 * GameSimulation 的 tick 级 catch 之外本层保证——逐 handler try/catch）。
 */
export function dispatchEvents(world: GameWorld): void {
  const events = drainEvents(world);
  for (const evt of events) {
    const handlers = world.eventBus.handlers.get(evt.name);
    if (!handlers) continue;
    for (const handler of [...handlers]) {
      try {
        handler(evt.payload, world);
      } catch (err) {
        world.logger.warn("事件处理器执行失败", {
          name: evt.name,
          error: err instanceof Error ? err.stack : String(err),
        });
      }
    }
  }
}
