import { PHASE_DAY, PHASE_NIGHT, type GameWorld } from "world";
import type { RegistrationMetadata } from "framework/registryMetadata";
import { assertStrictConfigSchema } from "framework/registryMetadata";
import { environmentAt } from "framework/simulation/worldClock";

/**
 * 刷怪条件模块注册表（名 → 判定函数）。
 *
 * 实体演化规则（EntityRule）的 `condition` 字段按名字引用这里注册的条件；
 * 条件只依赖世界状态（如 world.time.timeOfDay.phase、environmentAt(world)），
 * 不含游戏语义。
 *
 * **带参条件**：条件名可写成 `基名:参数`（参数取值来自 game/ 配置），
 * 参数由带参条件工厂接收。基名与参数均保持通用、无游戏语义。
 */
export type SpawnCondition = (world: GameWorld) => boolean;

/** 带参条件判定函数：第二参数为条件名分隔符后的字符串参数。 */
export type ParameterizedSpawnCondition = (world: GameWorld, arg: string) => boolean;

/** 带参条件名分隔符（`基名:参数` → 基名 + 参数）。 */
export const SPAWN_CONDITION_ARG_SEPARATOR = ":";

/** 刷怪条件注册条目（含可选元数据），供配置编辑器消费。 */
export interface SpawnConditionEntry extends RegistrationMetadata {
  /** 条件注册名（EntityRule.condition 引用键）。 */
  name: string;
  /** 无参条件判定函数（带参条目为空——见 parameterized）。 */
  condition?: SpawnCondition;
  /** 是否为带参条件：配置引用需形如 `基名:参数`。 */
  parameterized?: boolean;
}

/** 内部注册记录（带参条目额外持工厂，不对外暴露）。 */
interface SpawnConditionRecord extends RegistrationMetadata {
  name: string;
  condition?: SpawnCondition;
  parameterizedFactory?: (arg: string) => SpawnCondition;
}

const spawnConditions = new Map<string, SpawnConditionRecord>();

/** 注册无参刷怪条件（重名抛错，防配置引用歧义与插件覆盖）。可选元数据随条目保存供编辑器消费。 */
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

/**
 * 注册带参刷怪条件：`工厂(参数) → 判定函数`。配置中以 `基名:参数` 引用；
 * 未知名/无参误用时求值抛错（与无参条件同约定）。
 */
export function registerParameterizedSpawnCondition(
  name: string,
  factory: (arg: string) => SpawnCondition,
  meta?: RegistrationMetadata,
): void {
  if (spawnConditions.has(name)) {
    throw new Error(`Spawn condition "${name}" is already registered`);
  }
  assertStrictConfigSchema(name, meta?.configSchema);
  spawnConditions.set(name, { name, parameterizedFactory: factory, ...meta });
}

/**
 * 取刷怪条件判定函数（未注册抛错——引用未知条件属配置错误，尽早暴露）。
 * 带参条件名（`基名:参数`）解析为绑定参数后的判定函数。
 */
export function getSpawnCondition(name: string): SpawnCondition {
  const exact = spawnConditions.get(name);
  if (exact?.condition) return exact.condition;

  const sep = name.indexOf(SPAWN_CONDITION_ARG_SEPARATOR);
  if (sep > 0) {
    const base = spawnConditions.get(name.slice(0, sep));
    if (base?.parameterizedFactory) {
      return base.parameterizedFactory(name.slice(sep + 1));
    }
  }
  throw new Error(`Spawn condition "${name}" is not registered`);
}

/** 列出全部已注册刷怪条件条目（含 description / configSchema），供 sidecar listRegistries 消费。 */
export function listSpawnConditions(): SpawnConditionEntry[] {
  return [...spawnConditions.values()].map((record) => {
    const entry: SpawnConditionEntry = { name: record.name };
    if (record.condition) entry.condition = record.condition;
    if (record.parameterizedFactory) entry.parameterized = true;
    if (record.description !== undefined) entry.description = record.description;
    if (record.configSchema !== undefined) entry.configSchema = record.configSchema;
    return entry;
  });
}

/**
 * 刷怪条件是否已注册（加载期完整性校验先用它预检，避免 get 抛错中断加载）。
 * 带参条件名（`基名:参数`）在基名为带参条件时返回 true。
 */
export function hasSpawnCondition(name: string): boolean {
  if (spawnConditions.get(name)?.condition) return true;
  const sep = name.indexOf(SPAWN_CONDITION_ARG_SEPARATOR);
  if (sep > 0) {
    return spawnConditions.get(name.slice(0, sep))?.parameterizedFactory !== undefined;
  }
  return false;
}

/** 注册内建刷怪条件。由 bootstrapFramework 调用。 */
export function registerBuiltinSpawnConditions(): void {
  registerSpawnCondition("isNight", (world) => world.time.timeOfDay.phase === PHASE_NIGHT);
  registerSpawnCondition("isDay", (world) => world.time.timeOfDay.phase === PHASE_DAY);

  // 相位/天气条件（通用名；相位/天气 id 来自 game/ 配置）：
  // 从 tick 直接派生（读缓存无必要），离线补差与在线同值。
  registerParameterizedSpawnCondition("inPhase", (arg) => (world) =>
    environmentAt(world).phaseId === arg,
  );
  registerParameterizedSpawnCondition("isWeather", (arg) => (world) =>
    environmentAt(world).weatherId === arg,
  );
}
