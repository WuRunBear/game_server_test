/**
 * 内建系统注册：把框架自带的所有系统按「id → factory」注册进 SystemRegistry。
 *
 * 每个注册项通过 after/before 声明依赖顺序，构成一条可推理的执行链：
 *
 *   perception → ai → physics → movement → collision → combat
 *     → spawning → inventory → gathering → interaction → equipment
 *     → needDecay → death → respawn → portal → quest
 *
 * 实际启用哪些系统、按什么顺序跑，由 game.json 的 `systems[]` 配置决定
 * （buildSystems 只实例化配置里启用的 id）；这里的 after/before 只是
 * 未显式配置时的默认排序依据。注册名即配置引用名，游戏侧可用同名覆盖替换。
 */
import type { SystemRegistry } from "framework/systems/systemRegistry";
import type { ActionRegistry } from "framework/ai/actionRegistry";
import type { GameWorld } from "framework/world";

import { physicsSystem } from "framework/systems/core/physicsSystem";
import { movementSystem } from "framework/systems/core/movementSystem";
import { collisionSystem } from "framework/systems/core/collisionSystem";
import { aiSystem } from "framework/systems/gameplay/aiSystem";
import { perceptionSystem } from "framework/systems/gameplay/perceptionSystem";
import { createCombatSystem } from "framework/systems/gameplay/combatSystem";
import { deathSystem } from "framework/systems/gameplay/deathSystem";
import { respawnSystem } from "framework/systems/gameplay/respawnSystem";
import { inventorySystem } from "framework/systems/gameplay/inventorySystem";
import { createInteractionSystem } from "framework/systems/gameplay/interactionSystem";
import { spawningSystem } from "framework/systems/gameplay/spawningSystem";
import { needDecaySystem } from "framework/systems/gameplay/needDecaySystem";
import { gatheringSystem } from "framework/systems/gameplay/gatheringSystem";
import { equipmentSystem } from "framework/systems/gameplay/equipmentSystem";
import { dayNightCycleSystem } from "framework/systems/gameplay/dayNightCycleSystem";
import { portalSystem } from "framework/systems/gameplay/portalSystem";
import { createQuestSystem } from "framework/systems/gameplay/questSystem";

import { setDefaultActionRegistry } from "framework/ai/btFactory";
import { registerBuiltinActions } from "framework/ai/registerBuiltinActions";

/**
 * 注册全部内建系统。
 *
 * 先注册内建行为树动作并设为 btFactory 的默认动作注册表
 * （aiSystem 建树时按配置里的动作名查它），再逐个注册系统。
 * @param systemRegistry 系统注册表（由 bootstrap 创建并传入）
 * @param actionRegistry 行为树动作注册表（供 aiSystem 使用）
 */
export function registerBuiltinSystems(
  systemRegistry: SystemRegistry,
  actionRegistry: ActionRegistry,
): void {
  // AI 前置：动作注册表就绪后 aiSystem 才能把配置行为树编译成可执行树
  registerBuiltinActions(actionRegistry);
  setDefaultActionRegistry(actionRegistry);

  // 感知：收集视野内的目标写入黑板，必须在 ai 之前（ai 决策依赖感知结果）
  systemRegistry.register({
    id: "perception",
    factory: (_world: GameWorld) => perceptionSystem,
    before: ["ai"],
  });

  // AI：驱动实体按行为树决策（产出 Velocity 等意图），随后物理才消费
  systemRegistry.register({
    id: "ai",
    factory: (_world: GameWorld) => aiSystem,
    defaultOrder: 10,
  });

  // 物理：按加速度更新速度（只处理同时挂 Velocity+Acceleration 的实体）
  systemRegistry.register({
    id: "physics",
    factory: (_world: GameWorld) => physicsSystem,
    after: ["ai"],
  });

  // 移动：速度积分到位置（位置 += 速度 × dt）
  systemRegistry.register({
    id: "movement",
    factory: (_world: GameWorld) => movementSystem,
    after: ["physics"],
  });

  // 碰撞：检测重叠并分离（基于 check2d SAT），位置移动后立刻纠正穿模
  systemRegistry.register({
    id: "collision",
    factory: (_world: GameWorld) => collisionSystem,
    after: ["movement"],
  });

  // 战斗：攻击判定/伤害结算（可带配置，如友伤开关），依赖碰撞后的位置关系
  systemRegistry.register({
    id: "combat",
    factory: (_world: GameWorld, config?: Record<string, unknown>) => createCombatSystem(config),
    after: ["collision"],
  });

  // 刷怪：按规则在地图出生点生成实体，战斗之后保证场内单位数稳定
  systemRegistry.register({
    id: "spawning",
    factory: (_world: GameWorld) => spawningSystem,
    after: ["combat"],
  });

  // 昼夜：推进 world.time.timeOfDay（hour/phase），刷怪等行为可能按它分支
  systemRegistry.register({
    id: "dayNight",
    factory: (_world: GameWorld) => dayNightCycleSystem,
    before: ["spawning"],
  });

  // 背包：消费输入意图（拾取/丢弃/整理），依赖刚生成的掉落物在场
  systemRegistry.register({
    id: "inventory",
    factory: (_world: GameWorld) => inventorySystem,
    after: ["spawning"],
  });

  // 采集：对资源节点执行采集（产出物品进背包），背包处理完输入后执行
  systemRegistry.register({
    id: "gathering",
    factory: (_world: GameWorld) => gatheringSystem,
    after: ["inventory"],
  });

  // 交互：处理 talk/use 等交互意图（可带配置），依赖采集之后的物品状态
  systemRegistry.register({
    id: "interaction",
    factory: (_world: GameWorld, config?: Record<string, unknown>) => createInteractionSystem(config),
    after: ["gathering"],
  });

  // 装备：装备/卸下并应用属性修正（EMPTY_MODIFIERS 兜底）
  systemRegistry.register({
    id: "equipment",
    factory: (_world: GameWorld) => equipmentSystem,
    after: ["interaction"],
  });

  // 需求衰减：需求随时间下降，归零扣血；只扣血不处理死亡
  systemRegistry.register({
    id: "needDecay",
    factory: (_world: GameWorld) => needDecaySystem,
    after: ["combat"],
  });

  // 死亡：Health ≤ 0 的实体做掉落/重生/移除（统一入口，其他系统不自行删除）
  systemRegistry.register({
    id: "death",
    factory: (_world: GameWorld) => deathSystem,
    after: ["needDecay"],
  });

  // 重生：按死亡结果安排重生/复活，死亡处理完成后执行
  systemRegistry.register({
    id: "respawn",
    factory: (_world: GameWorld) => respawnSystem,
    after: ["death"],
  });

  // 传送门：实体触碰传送点跨地图切换，生命周期较靠后避免影响本帧其他系统
  systemRegistry.register({
    id: "portal",
    factory: (_world: GameWorld) => portalSystem,
    after: ["respawn"],
  });

  // 任务：接受/提交/结算（事件总线驱动），放在链尾确保其他系统结果已就绪
  systemRegistry.register({
    id: "quest",
    factory: (_world: GameWorld) => createQuestSystem(),
    after: ["respawn"],
  });
}
