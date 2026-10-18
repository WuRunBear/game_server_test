/**
 * Offline 组件：断线保留标记（SoA，**入档**——保留语义跨重启有效）。
 *
 * 玩家会话断开时，仿真层不立即销毁实体，而是挂上本组件并写入到期 tick：
 * 保留期内实体继续存在于 ECS（进度不丢、重连可复用），但对同步与玩法系统
 * **不可见**——各消费点（快照/感知/袭击/需求衰减/投射物命中）统一按
 * isOfflineRetained 标记跳过，不做散落的时间比较。
 *
 * 生命周期：
 * - 挂载：removePlayer（保留时长来自 rules/server.json 的 offlineRetentionTicks）
 * - 摘除：addPlayer 按客户端自报 networkId 命中该实体时（重连恢复会话）
 * - 到期：仿真层每 tick 清扫点销毁实体并触发一次立即存档
 *
 * 入档原因：重启后保留中的玩家实体若丢标记，会重新进入饥饿/感知/袭击/同步，
 * 成为"幽灵玩家"；读档路径显式恢复本组件并保留绝对 untilTick，到期由既有
 * 清扫点处理。旧档（无 Offline 字段）恢复出的玩家实体由 GameSimulation 在
 * 开机时补标记为离线保留。
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
