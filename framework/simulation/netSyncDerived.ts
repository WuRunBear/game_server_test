/**
 * netSync 派生投影（非 ECS 组件）登记表。
 *
 * netSync.fields 通常引用已注册组件；少数同步数据没有对应组件，而是由
 * buildSnapshot 从运行时状态直接派生。这些名字必须：
 * - 通过 `loadGameDefinition` 的完整性校验（不查组件注册表，只查 tags）；
 * - 在 `GameSimulation.buildSnapshot` 里有对应分支。
 *
 * 当前：
 * - `Crafting`：world.craftingJobs 是运行时任务表（见 craftingSystem），
 *   由 writeCraftingProjection 展平为 `Crafting.<i>.*` 动态 key。
 * - `Action`：动作时间轴瞬态状态（见 simulation/actions/actionState），
 *   由 writeActionProjection 走 AoS 同步适配器展平为 `Action.*` 动态 key；
 *   不注册为持久 AoS 组件（动作不跨存档恢复）。
 */

import { ACTION_SYNC_COMPONENT } from "framework/simulation/actions/actionState";

/** 制作进度派生的伪组件名（同步键空间 `Crafting.<i>.*`）。 */
export const CRAFTING_SYNC_COMPONENT = "Crafting";

/** 动作时间轴派生的伪组件名（同步键空间 `Action.*`）。 */
export { ACTION_SYNC_COMPONENT };

const DERIVED_NET_SYNC_COMPONENTS: ReadonlySet<string> = new Set([
  CRAFTING_SYNC_COMPONENT,
  ACTION_SYNC_COMPONENT,
]);

/** 判断 netSync 条目名是否为派生投影伪组件（无需注册组件）。 */
export function isDerivedNetSyncComponent(name: string): boolean {
  return DERIVED_NET_SYNC_COMPONENTS.has(name);
}
