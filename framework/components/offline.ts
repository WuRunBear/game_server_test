/**
 * Offline 组件：断线保留标记（SoA，瞬态——不入存档）。
 *
 * 玩家会话断开时，仿真层不立即销毁实体，而是挂上本组件并写入到期 tick：
 * 保留期内实体继续存在于 ECS（进度不丢、重连可复用），但对同步与玩法系统
 * **不可见**——各消费点（快照/感知/袭击/需求衰减/投射物命中）统一按
 * isOfflineRetained 标记跳过，不做散落的时间比较。
 *
 * 生命周期：
 * - 挂载：removePlayer（保留时长来自 rules/server.json 的 offlineRetentionTicks）
 * - 摘除：addPlayer 复用该实体时（重连恢复会话）
 * - 到期：仿真层每 tick 清扫点销毁实体并触发一次立即存档
 *
 * 瞬态原因：保留是"会话断开"这一运行时事实，跨存档无意义——读档路径的
 * 玩家实体复用走 orphan 队列（restoreWorld 返回值），无需保留标记参与。
 */
import { defineComponent, Types } from "bitecs/legacy";
import { hasComponent } from "bitecs";
import type { GameWorld } from "framework/world";

export const Offline = defineComponent({
  /** 保留到期 tick（绝对值）；到期由仿真层清扫点销毁。 */
  untilTick: Types.ui32,
});

/**
 * 实体是否处于断线保留期。
 *
 * 这是保留期"不可见"语义的**唯一判定入口**：快照构建（buildSnapshot）、
 * 感知（perceptionSystem）、袭击（raidSystem）、需求衰减（needDecaySystem）、
 * 投射物命中（projectileSystem）等消费点一律按本标记跳过——保留期的兴趣
 * 排除由快照门控传递达成（interest 只读快照，快照不含保留实体）。
 */
export function isOfflineRetained(world: GameWorld, eid: number): boolean {
  return hasComponent(world, eid, Offline);
}
