/**
 * 系统模块的统一出口（barrel）。
 *
 * 对外只暴露各系统的工厂/入口函数与注册辅助：
 * - core 下的物理 / 移动 / 碰撞系统是每 tick 都要跑的通用基础系统
 * - gameplay 下是 AI / 战斗 / 生成 / 背包 / 交互等按 game.json 配置启用的玩法系统
 * 使用方（game.json 的 systems[]）通过系统 id 引用，经 systemRegistry 构建执行链。
 */
export { physicsSystem } from "framework/systems/core/physicsSystem";
export { movementSystem } from "framework/systems/core/movementSystem";
export { collisionSystem, getCollisionDebugSnapshot, type CollisionDebugSnapshot } from "framework/systems/core/collisionSystem";
export { aiSystem, setEntityKind } from "framework/systems/gameplay/aiSystem";
export { combatSystem, createCombatSystem } from "framework/systems/gameplay/combatSystem";
export { spawningSystem } from "framework/systems/gameplay/spawningSystem";
export { inventorySystem } from "framework/systems/gameplay/inventorySystem";
export { interactionSystem } from "framework/systems/gameplay/interactionSystem";
