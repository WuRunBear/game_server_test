import { PHASE_NIGHT, type GameWorld } from "world";

/**
 * 刷怪条件模块注册表（名 → 判定函数）。
 *
 * 实体演化规则（EntityRule）的 `condition` 字段按名字引用这里注册的条件；
 * 条件只依赖世界状态（如 world.time.timeOfDay.phase），不含游戏语义。
 */
export type SpawnCondition = (world: GameWorld) => boolean;

const spawnConditions = new Map<string, SpawnCondition>();

/** 注册刷怪条件（重名抛错，防配置引用歧义与插件覆盖）。 */
export function registerSpawnCondition(name: string, condition: SpawnCondition): void {
  if (spawnConditions.has(name)) {
    throw new Error(`Spawn condition "${name}" is already registered`);
  }
  spawnConditions.set(name, condition);
}

/** 取刷怪条件判定函数（未注册抛错——引用未知条件属配置错误，尽早暴露）。 */
export function getSpawnCondition(name: string): SpawnCondition {
  const condition = spawnConditions.get(name);
  if (!condition) {
    throw new Error(`Spawn condition "${name}" is not registered`);
  }
  return condition;
}

/** 刷怪条件是否已注册（加载期完整性校验先用它预检，避免 get 抛错中断加载）。 */
export function hasSpawnCondition(name: string): boolean {
  return spawnConditions.has(name);
}

/** 注册内建刷怪条件。由 bootstrapFramework 调用。 */
export function registerBuiltinSpawnConditions(): void {
  registerSpawnCondition("isNight", (world) => world.time.timeOfDay.phase === PHASE_NIGHT);
}
