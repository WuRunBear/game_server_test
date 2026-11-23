/**
 * 类型化事件总线——tick 内排队、固定阶段消费的系统间事件通道。
 *
 * 与 framework/events/gameEvents.ts（帧内轻量事件：emit/consume 清空式）互补：
 * - gameEvents：系统在 tick 链内 emit + consume，无订阅者概念，事件不跨帧；
 * - 本模块：事件名 → 载荷类型化的队列，由系统在**固定阶段**显式消费
 *   （不自动派发，保持系统拓扑确定性）； GameInstance.step 帧首清空残留，
 *   事件只在产生它的那一 tick 有效。
 *
 * 唯一消费方式：`drainEvents` 整体取出队列自行处理（triggerSystem 用它做
 * 声明式触发器求值）。不提供订阅者分发路径——避免出现两套消费方争抢同一
 * 队列（先 drain 后 dispatch 会得到空队列）。
 *
 * 游戏无关——事件名与载荷结构由 TypedEventPayloads 声明（interface merging 可扩展）。
 */
import type { GameWorld } from "framework/world";
import { Triggers, type TriggerEntry } from "framework/simulation/triggers/triggers";

/**
 * 类型化事件载荷表：事件名 → 载荷结构。
 *
 * 命名约定：触发器求值器名 = 事件名（triggerRegistry 按 on-* 名注册）。
 * 除 on-region-*（仅保留求值器、暂无产生方）外，本表全部事件已有产生方，
 * 配置可直接声明 Triggers 消费。
 */
export interface TypedEventPayloads {
  /** 定时器触发（timerSystem 入队；phase 区分一次性到期/周期触发）。 */
  "on-timer": { eid: number; phase: "expired" | "interval" };
  /** 玩家命令执行成功（GameSimulation 缓存、下一 tick 系统阶段前入队）。 */
  "on-command": { eid: number; type: string };
  /** 投射物接触实体（projectileSystem 入队；eid=投射物主人，target=被接触实体）。 */
  "on-contact": { eid: number; target: number; x: number; y: number };
  /** 攻击命中（combatSystem 入队；eid=攻击者，target=被命中实体，damage=实际伤害）。 */
  "on-hit": { eid: number; attacker: number; target: number; damage: number; crit?: boolean; damageType?: string };
  /** 实体死亡（death 接线预留）。 */
  "on-death": { eid: number; kind: string };
  /** 装备物品耐久耗尽破碎（durability 磨损点入队；eid=持有者，slot=装备槽名）。 */
  "on-item-break": { eid: number; kind: string; slot: string };
  /** 进入区域（region 接线预留）。 */
  "on-region-enter": { eid: number; region: string };
  /** 离开区域（region 接线预留）。 */
  "on-region-clear": { eid: number; region: string };
  /** 袭击预警（raidSystem 袭击导演入队；预警期内每 tick 对在线玩家各发一条，remainingTicks 为距刷波的剩余 tick 数）。 */
  "on-raid-warning": { eid: number; remainingTicks: number };
  /**
   * 成就解锁（achievementSystem 入队；eid=触发玩家，无玩家时为 0）。
   *
   * 未注册触发器求值器时 triggerSystem 自然丢弃——成就本身的服务端权威
   * 状态以 world.progress["achievement:<id>"] 为准。
   */
  "on-achievement": { eid: number; id: string; name?: string };
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
  /**
   * 入队时 owner（载荷字段 `eid`）的声明式触发器快照。
   *
   * 事件在固定阶段消费，而实体可能在本 tick 更早的系统里已被销毁
   * （on-death：deathSystem 先入队再 destroyEntity，triggerSystem 在系统链
   * 末段才消费）——入队时快照保证声明式触发器仍可求值。无触发器时缺省。
   */
  triggers?: TriggerEntry[];
}

/** 事件总线结构（挂在 world.eventBus 上，per-world 实例）。 */
export interface EventBus {
  /** 本 tick 待消费队列（FIFO）。 */
  queue: QueuedEvent[];
}

/** 创建空事件总线（帧首由 GameInstance.step 清空 queue）。 */
export function createEventBus(): EventBus {
  return { queue: [] };
}

/**
 * 非破坏性 tap：在事件**入队时**旁路观察（不影响 drain 语义/顺序/归属）。
 *
 * 用途：CC-04 客户端事件 outbox 需要读取 on-hit/on-death 等帧内事件，但
 * eventBus 的唯一消费方是 triggerSystem（drain 后队列即空）。tap 只是观察者，
 * 不取走事件、不改变 QueuedEvent 结构。
 */
export type EventQueueTap = (name: string, payload: unknown) => void;

/** world → tap 集合（模块级 WeakMap，不给 EventBus 公共结构加字段）。 */
const tapsByWorld = new WeakMap<GameWorld, Set<EventQueueTap>>();

/**
 * 注册事件入队 tap。
 *
 * @returns 取消注册函数（world 生命周期内通常无需调用）
 */
export function tapEvents(world: GameWorld, tap: EventQueueTap): () => void {
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

/**
 * 入队一个类型化事件（追加到本 tick 队列尾部）。
 * 载荷结构由 TypedEventPayloads 按事件名静态约束。
 */
export function queueEvent<N extends TypedEventName>(
  world: GameWorld,
  name: N,
  payload: TypedEventPayload<N>,
): void {
  // 入队时快照 owner 的声明式触发器：事件消费阶段实体可能已被销毁
  // （on-death 的典型时序），快照保证 Triggers 声明仍可求值。
  const eid = (payload as { eid?: unknown }).eid;
  const triggers = typeof eid === "number" ? Triggers[eid] : undefined;
  world.eventBus.queue.push({ name, payload, ...(triggers ? { triggers } : {}) });

  // 非破坏性旁路观察（tap 抛错不得影响事件生产/消费链）。
  const taps = tapsByWorld.get(world);
  if (taps) {
    for (const tap of taps) {
      try {
        tap(name, payload);
      } catch (err) {
        world.logger.warn("eventBus tap 执行失败（已忽略）", {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
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
