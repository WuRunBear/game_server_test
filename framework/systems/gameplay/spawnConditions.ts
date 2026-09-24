import { PHASE_DAY, PHASE_NIGHT, type GameWorld } from "world";
import type { RegistrationMetadata } from "framework/registryMetadata";
import { assertStrictConfigSchema } from "framework/registryMetadata";

/**
 * 刷怪条件模块注册表（名 → 判定函数）。
 *
 * 实体演化规则（EntityRule）的 `condition` 字段按名字引用这里注册的条件；
 * 条件只依赖世界状态（如 world.time.timeOfDay.phase），不含游戏语义。
 */
export type SpawnCondition = (world: GameWorld) => boolean;

/** 刷怪条件注册条目（含可选元数据），供配置编辑器消费。 */
export interface SpawnConditionEntry extends RegistrationMetadata {
  /** 条件注册名（EntityRule.condition 引用键）。 */
  name: string;
  /** 条件判定函数。 */
  condition: SpawnCondition;
}

const spawnConditions = new Map<string, SpawnConditionEntry>();

/** 注册刷怪条件（重名抛错，防配置引用歧义与插件覆盖）。可选元数据随条目保存供编辑器消费。 */
export function registerSpawnCondition(
  name: string,
  condition: SpawnCondition,
  meta?: RegistrationMetadata,
): void {
  if (spawnConditions.has(name)) {
    throw new Error(`Spawn condition "${name}" is already registered`);
  }
  assertStrictConfigSchema(name, meta?.configSchema);
  spawnConditions.set(name, { name, condition, ...meta });
}

/** 取刷怪条件判定函数（未注册抛错——引用未知条件属配置错误，尽早暴露）。 */
export function getSpawnCondition(name: string): SpawnCondition {
  const entry = spawnConditions.get(name);
  if (!entry) {
    throw new Error(`Spawn condition "${name}" is not registered`);
  }
  return entry.condition;
}

/** 列出全部已注册刷怪条件条目（含 description / configSchema），供 sidecar listRegistries 消费。 */
export function listSpawnConditions(): SpawnConditionEntry[] {
  return [...spawnConditions.values()];
}

/** 刷怪条件是否已注册（加载期完整性校验先用它预检，避免 get 抛错中断加载）。 */
export function hasSpawnCondition(name: string): boolean {
  return spawnConditions.has(name);
}

/** 注册内建刷怪条件。由 bootstrapFramework 调用。 */
export function registerBuiltinSpawnConditions(): void {
  registerSpawnCondition("isNight", (world) => world.time.timeOfDay.phase === PHASE_NIGHT);
  registerSpawnCondition("isDay", (world) => world.time.timeOfDay.phase === PHASE_DAY);
}
