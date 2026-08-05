import { PHASE_NIGHT, type GameWorld } from "world";

/**
 * 刷怪条件模块注册表（名 → 判定函数）。
 *
 * SpawnRuleJson 的 `condition` 字段按名字引用这里注册的条件；
 * 条件只依赖世界状态（如 world.time.timeOfDay.phase），不含游戏语义。
 */
export type SpawnCondition = (world: GameWorld) => boolean;

const spawnConditions = new Map<string, SpawnCondition>();

export function registerSpawnCondition(name: string, condition: SpawnCondition): void {
  if (spawnConditions.has(name)) {
    throw new Error(`Spawn condition "${name}" is already registered`);
  }
  spawnConditions.set(name, condition);
}

export function getSpawnCondition(name: string): SpawnCondition {
  const condition = spawnConditions.get(name);
  if (!condition) {
    throw new Error(`Spawn condition "${name}" is not registered`);
  }
  return condition;
}

export function hasSpawnCondition(name: string): boolean {
  return spawnConditions.has(name);
}

/** 注册内建刷怪条件。由 bootstrapFramework 调用。 */
export function registerBuiltinSpawnConditions(): void {
  registerSpawnCondition("isNight", (world) => world.time.timeOfDay.phase === PHASE_NIGHT);
}
