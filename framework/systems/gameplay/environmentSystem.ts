import type { GameWorld } from "world";
import { environmentAt } from "framework/simulation/worldClock";

/**
 * environmentSystem：把 WorldClock 相位/天气派生到 `world.time.environment`。
 *
 * 每 tick 从 `world.time.tick` + environment 规则**重算**（纯函数，无累积状态）——
 * 在线推进与离线补差得到同一结果，无需重放。未配置 environment 规则时为中性视图。
 * 不触碰既有 timeOfDay 语义（dayNightCycleSystem 仍独立推进）。
 */
export function environmentSystem(world: GameWorld): GameWorld {
  world.time.environment = environmentAt(world);
  return world;
}
