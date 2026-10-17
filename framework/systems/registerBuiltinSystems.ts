import { z } from "zod";
import type { SystemRegistry } from "framework/systems/systemRegistry";
import type { ActionRegistry } from "framework/ai/actionRegistry";
import type { GameWorld } from "framework/world";

import { physicsSystem } from "framework/systems/core/physicsSystem";
import { movementSystem } from "framework/systems/core/movementSystem";
import { entityLevelSystem } from "framework/systems/core/entityLevelSystem";
import { collisionSystem } from "framework/systems/core/collisionSystem";
import { aiSystem } from "framework/systems/gameplay/aiSystem";
import { perceptionSystem } from "framework/systems/gameplay/perceptionSystem";
import { createCombatSystem } from "framework/systems/gameplay/combatSystem";
import { deathSystem } from "framework/systems/gameplay/deathSystem";
import { respawnSystem } from "framework/systems/gameplay/respawnSystem";
import { inventorySystem } from "framework/systems/gameplay/inventorySystem";
import { createInteractionSystem } from "framework/systems/gameplay/interactionSystem";
import { needDecaySystem } from "framework/systems/gameplay/needDecaySystem";
import { gatheringSystem } from "framework/systems/gameplay/gatheringSystem";
import { equipmentSystem } from "framework/systems/gameplay/equipmentSystem";
import { dayNightCycleSystem } from "framework/systems/gameplay/dayNightCycleSystem";
import { environmentSystem } from "framework/systems/gameplay/environmentSystem";
import { portalSystem } from "framework/systems/gameplay/portalSystem";
import { createQuestSystem } from "framework/systems/gameplay/questSystem";
import { createNestSystem } from "framework/systems/gameplay/nestSystem";
import { raidSystem } from "framework/systems/gameplay/raidSystem";
import { createDisasterSystem } from "framework/systems/gameplay/disasterSystem";

import { setDefaultActionRegistry } from "framework/ai/btFactory";
import { registerBuiltinActions } from "framework/ai/registerBuiltinActions";
import { timerSystem } from "framework/simulation/timer/timerSystem";
import { triggerSystem } from "framework/simulation/triggers/triggerSystem";
import { modifierSystem } from "framework/simulation/modifiers/modifierSystem";
import { stateMachineSystem } from "framework/simulation/stateMachine/stateMachineSystem";
import { createPopulationSystem } from "framework/simulation/population/populationSystem";
import { projectileSystem } from "framework/systems/gameplay/projectileSystem";

export function registerBuiltinSystems(
  systemRegistry: SystemRegistry,
  actionRegistry: ActionRegistry,
): void {
  registerBuiltinActions(actionRegistry);
  setDefaultActionRegistry(actionRegistry);

  systemRegistry.register({
    id: "perception",
    description: "感知扫描：在视野半径内筛选最近的可感知敌对实体并写入黑板，供行为树消费。",
    factory: (_world: GameWorld) => perceptionSystem,
    before: ["ai"],
  });

  systemRegistry.register({
    id: "ai",
    description: "行为树驱动：按实体 kind 对应的原型行为配置，每 tick 步进 NPC 行为树。",
    factory: (_world: GameWorld) => aiSystem,
    defaultOrder: 10,
  });

  systemRegistry.register({
    id: "physics",
    description: "物理积分：把加速度按 dt 积分到速度（v += a·dt）。",
    factory: (_world: GameWorld) => physicsSystem,
    after: ["ai"],
  });

  systemRegistry.register({
    id: "movement",
    description: "移动积分：把速度按 dt 积分到位置（p += v·dt）。",
    factory: (_world: GameWorld) => movementSystem,
    after: ["physics"],
  });

  // 实体层号：按位置推导实体所在离散层并写回 EntityLevel（格中心越过滞回，
  // slope ±1 / cliff 单向；碰撞按层分区的路由依据）
  systemRegistry.register({
    id: "entity-level",
    description: "实体层号：按位置与所在图地形推导实体离散层号（格中心越过滞回；slope ±1 双向、cliff 高→低单向）。",
    factory: (_world: GameWorld) => entityLevelSystem,
    after: ["movement"],
    before: ["collision"],
  });

  systemRegistry.register({
    id: "collision",
    description: "碰撞分离：基于 SAT 分离地图阻挡与实体重叠，修正位置并清零受阻轴速度（按图×层分区）。",
    factory: (_world: GameWorld) => collisionSystem,
    after: ["movement"],
  });

  systemRegistry.register({
    id: "combat",
    description: "战斗冷却：逐 tick 递减实体攻击冷却；伤害、射程、公式等参数由 rules/combat.json 规则决定。",
    factory: (_world: GameWorld, config?: Record<string, unknown>) => createCombatSystem(config),
    after: ["collision"],
  });

  systemRegistry.register({
    id: "dayNight",
    description: "昼夜循环：按 daynight 规则推进世界时间并计算日夜相位。",
    factory: (_world: GameWorld) => dayNightCycleSystem,
  });

  // 环境时钟：按 environment 规则从 tick 派生相位/天气（纯函数，排在 dayNight 之后）
  systemRegistry.register({
    id: "environment",
    description: "环境时钟：按 environment 规则从 tick 派生相位与天气（WorldClock，纯函数派生）。",
    factory: (_world: GameWorld) => environmentSystem,
    after: ["dayNight"],
  });

  systemRegistry.register({
    id: "inventory",
    description: "自动拾取：玩家靠近地面物品时并入背包，支持部分入与满包不吞。",
    factory: (_world: GameWorld) => inventorySystem,
    after: ["combat"],
  });

  systemRegistry.register({
    id: "gathering",
    description: "资源再生：枯竭资源节点按 regenMs 回满，并提供 harvest 采集原子。",
    factory: (_world: GameWorld) => gatheringSystem,
    after: ["inventory"],
  });

  systemRegistry.register({
    id: "interaction",
    description: "交互路由：消费玩家交互/攻击/对话意图，按 range 路由到最近的目标实体。",
    configSchema: z.object({
      /** 交互触发半径（像素）。 */
      range: z.number().min(0).default(24),
    }),
    factory: (_world: GameWorld, config?: Record<string, unknown>) => createInteractionSystem(config),
    after: ["gathering"],
  });

  systemRegistry.register({
    id: "equipment",
    description: "装备加成：维护装备槽引用并提供攻击/防御/采集加成读取。",
    factory: (_world: GameWorld) => equipmentSystem,
    after: ["interaction"],
  });

  systemRegistry.register({
    id: "needDecay",
    description: "需求衰减：按 dt 衰减实体需求值，需求归零后持续扣除生命。",
    factory: (_world: GameWorld) => needDecaySystem,
    after: ["combat"],
  });

  systemRegistry.register({
    id: "death",
    description: "死亡处理：对生命归零实体结算掉落；玩家写重生标记，其余销毁。",
    factory: (_world: GameWorld) => deathSystem,
    after: ["needDecay"],
  });

  systemRegistry.register({
    id: "respawn",
    description: "重生：消费死亡标记，回满生命并传送回持久化出生点。",
    factory: (_world: GameWorld) => respawnSystem,
    after: ["death"],
  });

  systemRegistry.register({
    id: "portal",
    description: "传送门：玩家与传送区相交时切换到目标地图与坐标。",
    factory: (_world: GameWorld) => portalSystem,
    after: ["respawn"],
  });

  systemRegistry.register({
    id: "quest",
    description: "任务推进：检查进行中任务进度，并提供接受与提交任务原子。",
    factory: (_world: GameWorld) => createQuestSystem(),
    after: ["respawn"],
  });

  // 投射物：直线运动 + 墙阻挡 + 接触事件（命中闭环留配方切片）
  systemRegistry.register({
    id: "projectile",
    description: "投射物：直线运动、墙阻挡、接触检测与寿命销毁。",
    factory: (_world: GameWorld) => projectileSystem,
    after: ["movement"],
  });

  // 定时器：到期/到周期触发效果引用并清理（先于 trigger，同 tick 事件可被消费）
  systemRegistry.register({
    id: "timer",
    description: "定时器：到期或到周期时触发效果引用并清理条目。",
    factory: (_world: GameWorld) => timerSystem,
    after: ["quest"],
  });

  // 修饰符清理：每 tick 剔除过期属性修饰符条目（在战斗等消费方之前），
  // 避免持久化的 Modifiers 集合随状态反复施加无限膨胀
  systemRegistry.register({
    id: "modifier",
    description: "修饰符清理：每 tick 剔除过期属性修饰符条目并回收空集合。",
    factory: (_world: GameWorld) => modifierSystem,
    before: ["combat"],
  });

  // 触发器：固定阶段消费事件总线，求值实体 Triggers 声明的效果列表
  systemRegistry.register({
    id: "trigger",
    description: "触发器：固定阶段消费事件总线，按实体 Triggers 声明求值效果。",
    factory: (_world: GameWorld) => triggerSystem,
    after: ["timer"],
  });

  // 状态机：按配置状态图推进实体的定时/条件迁移（采集等即时信号在动作处同步应用）
  systemRegistry.register({
    id: "stateMachine",
    description: "状态机：按配置状态图推进实体的定时/条件状态迁移（通用 FSM，状态入档）。",
    factory: (_world: GameWorld) => stateMachineSystem,
    after: ["gathering"],
  });

  // 巢穴：周期在巢周围把 spawnKind 实体补到容量（radiusTiles/maxAttempts 走 systems[].config）
  systemRegistry.register({
    id: "nest",
    description: "巢穴：按周期把巢周围的 spawnKind 实体补足到容量。",
    configSchema: z.object({
      /** 巢周围计数与落位搜索半径（tile）。 */
      radiusTiles: z.number().positive().default(4),
      /** 单巢单门控的落位尝试上限。 */
      maxAttempts: z.number().positive().default(32),
    }),
    factory: (_world: GameWorld, config?: Record<string, unknown>) => createNestSystem(config),
    after: ["combat"],
  });

  // 周期袭击：rules/raid.json 驱动，按玩家位置周期刷敌对波（waveRef 规则模块可接管波构建）
  systemRegistry.register({
    id: "raid",
    description: "周期袭击：按 raid 规则周期在玩家周围生成敌对波。",
    factory: (_world: GameWorld) => raidSystem,
    after: ["combat"],
  });

  // 天气灾害：rules/disasters.json 驱动，灾害天气窗口内周期触发野火（写回焦土）与风暴伤害
  systemRegistry.register({
    id: "disaster",
    description: "天气灾害：按 disasters 规则在灾害天气下周期触发野火（点燃可燃实体/地面并写回焦土）与风暴伤害（露天实体周期掉血）。",
    factory: (_world: GameWorld, config?: Record<string, unknown>) => createDisasterSystem(config),
    after: ["environment"],
  });

  // 族群节点：按增长率确定性演进节点数量（离线快进在 GameSimulation.runOfflineCatchUp）；
  // 可选的实体生产通路（spawnInstances）参数走 systems[].config
  systemRegistry.register({
    id: "population",
    description: "族群节点：按承载力与增长率确定性演进节点数量，可选把节点数量落地为实体。",
    configSchema: z.object({
      /** 生产通路计数/落位搜索半径（tile）。 */
      radiusTiles: z.number().positive().default(4),
      /** 单节点单门控的落位尝试上限。 */
      maxPerSlot: z.number().positive().default(32),
    }),
    factory: (_world: GameWorld, config?: Record<string, unknown>) => createPopulationSystem(config),
    after: ["combat"],
  });
}
