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
import { needDecaySystem } from "framework/systems/gameplay/needDecaySystem";
import { gatheringSystem } from "framework/systems/gameplay/gatheringSystem";
import { equipmentSystem } from "framework/systems/gameplay/equipmentSystem";
import { dayNightCycleSystem } from "framework/systems/gameplay/dayNightCycleSystem";
import { portalSystem } from "framework/systems/gameplay/portalSystem";
import { createQuestSystem } from "framework/systems/gameplay/questSystem";

import { setDefaultActionRegistry } from "framework/ai/btFactory";
import { registerBuiltinActions } from "framework/ai/registerBuiltinActions";
import { timerSystem } from "framework/simulation/timer/timerSystem";
import { triggerSystem } from "framework/simulation/triggers/triggerSystem";
import { projectileSystem } from "framework/systems/gameplay/projectileSystem";

export function registerBuiltinSystems(
  systemRegistry: SystemRegistry,
  actionRegistry: ActionRegistry,
): void {
  registerBuiltinActions(actionRegistry);
  setDefaultActionRegistry(actionRegistry);

  systemRegistry.register({
    id: "perception",
    factory: (_world: GameWorld) => perceptionSystem,
    before: ["ai"],
  });

  systemRegistry.register({
    id: "ai",
    factory: (_world: GameWorld) => aiSystem,
    defaultOrder: 10,
  });

  systemRegistry.register({
    id: "physics",
    factory: (_world: GameWorld) => physicsSystem,
    after: ["ai"],
  });

  systemRegistry.register({
    id: "movement",
    factory: (_world: GameWorld) => movementSystem,
    after: ["physics"],
  });

  systemRegistry.register({
    id: "collision",
    factory: (_world: GameWorld) => collisionSystem,
    after: ["movement"],
  });

  systemRegistry.register({
    id: "combat",
    factory: (_world: GameWorld, config?: Record<string, unknown>) => createCombatSystem(config),
    after: ["collision"],
  });

  systemRegistry.register({
    id: "dayNight",
    factory: (_world: GameWorld) => dayNightCycleSystem,
  });

  systemRegistry.register({
    id: "inventory",
    factory: (_world: GameWorld) => inventorySystem,
    after: ["combat"],
  });

  systemRegistry.register({
    id: "gathering",
    factory: (_world: GameWorld) => gatheringSystem,
    after: ["inventory"],
  });

  systemRegistry.register({
    id: "interaction",
    factory: (_world: GameWorld, config?: Record<string, unknown>) => createInteractionSystem(config),
    after: ["gathering"],
  });

  systemRegistry.register({
    id: "equipment",
    factory: (_world: GameWorld) => equipmentSystem,
    after: ["interaction"],
  });

  systemRegistry.register({
    id: "needDecay",
    factory: (_world: GameWorld) => needDecaySystem,
    after: ["combat"],
  });

  systemRegistry.register({
    id: "death",
    factory: (_world: GameWorld) => deathSystem,
    after: ["needDecay"],
  });

  systemRegistry.register({
    id: "respawn",
    factory: (_world: GameWorld) => respawnSystem,
    after: ["death"],
  });

  systemRegistry.register({
    id: "portal",
    factory: (_world: GameWorld) => portalSystem,
    after: ["respawn"],
  });

  systemRegistry.register({
    id: "quest",
    factory: (_world: GameWorld) => createQuestSystem(),
    after: ["respawn"],
  });

  // 投射物：直线运动 + 墙阻挡 + 接触事件（命中闭环留配方切片）
  systemRegistry.register({
    id: "projectile",
    factory: (_world: GameWorld) => projectileSystem,
    after: ["movement"],
  });

  // 定时器：到期/到周期触发效果引用并清理（先于 trigger，同 tick 事件可被消费）
  systemRegistry.register({
    id: "timer",
    factory: (_world: GameWorld) => timerSystem,
    after: ["quest"],
  });

  // 触发器：固定阶段消费事件总线，求值实体 Triggers 声明的效果列表
  systemRegistry.register({
    id: "trigger",
    factory: (_world: GameWorld) => triggerSystem,
    after: ["timer"],
  });
}
