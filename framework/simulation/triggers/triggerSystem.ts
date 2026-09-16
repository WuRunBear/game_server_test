/**
 * triggerSystem：触发器 tick 体——固定阶段消费事件总线并求值触发器。
 *
 * 每 tick 整体取出类型化事件队列（drainEvents，清空式消费），对每个事件：
 * 1. 按事件名查 triggerRegistry 求值器（未注册的事件自然丢弃）；
 * 2. 载荷须携带 owner eid（约定字段 `eid`），缺省跳过；
 * 3. 读取该实体的 Triggers 组件，命中同名触发器条目 → 求值器执行效果列表。
 *
 * 系统位置：注册在 timer 之后（同 tick 内定时器事件可被同 tick 消费）。
 * 游戏无关——事件名/效果列表全为配置声明。
 */
import type { GameWorld } from "framework/world";
import { drainEvents } from "framework/simulation/events/eventBus";
import { getTrigger } from "framework/simulation/triggers/triggerRegistry";
import { Triggers, type TriggerEntry } from "framework/simulation/triggers/triggers";

/** triggerSystem tick 体：消费事件队列 → 求值命中实体的触发器。 */
export function triggerSystem(world: GameWorld): GameWorld {
  const events = drainEvents(world);

  for (const evt of events) {
    const evaluator = getTrigger(evt.name);
    if (!evaluator) continue;

    // 载荷约定：字段 eid = 触发源实体（挂载 Triggers 的实体）
    const payload = evt.payload as { eid?: unknown; target?: unknown } | null;
    if (!payload || typeof payload.eid !== "number") continue;
    const triggers = Triggers[payload.eid];
    if (!triggers || triggers.length === 0) continue;

    const target = typeof payload.target === "number" ? (payload.target as number) : payload.eid;
    for (const entry of triggers as TriggerEntry[]) {
      if (entry.trigger !== evt.name) continue;
      evaluator({ world, owner: payload.eid, payload: evt.payload, target }, entry.effects);
    }
  }

  return world;
}
