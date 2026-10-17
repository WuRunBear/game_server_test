/**
 * 寻路配置解析（framework/ai/pathfinding/config.ts）。
 *
 * 配置来源（不新增规则 schema，避免与 RuleSchema/ruleSchemas 的独占 lane 冲突）：
 * - 全局：game.json 的 systems 条目 `{ "id": "ai", "config": { "pathfinding": ... } }`；
 * - 单节点覆盖：行为树 action 的 `args.pathfinding`（`false` 关闭，对象覆盖字段）。
 *
 * 量纲：与框架 tile-units 机制一致——配置可写 `waypointToleranceTiles` /
 * `fleeGoalDistanceTiles`，加载期归一化为 px 键 `waypointTolerance` /
 * `fleeGoalDistance`；本模块只认 px 键（运行时唯一形态）。
 *
 * 校验在模块内 fail-fast：未知字段、错误类型、非正整数上限立刻抛错，避免
 * 拼写错误静默退化为默认值。全局配置在首次使用时解析并按 world 缓存。
 */
import type { GameWorld } from "world";

/** 寻路运行参数（全部为通用机制参数，无游戏名词）。 */
export interface PathfindingConfig {
  /** 是否启用寻路（false 时 Chase/Flee 完全走旧直线逻辑）。 */
  enabled: boolean;
  /** 重算间隔（tick）：间隔内复用缓存路径，不每 tick 跑 A*。 */
  repathTicks: number;
  /** 单次 A* 展开节点上限（超限回退直线）。 */
  maxNodes: number;
  /** 到达 waypoint 的判定半径（像素，tile-units 归一化后的形态）。 */
  waypointTolerance: number;
  /** Flee 的逃逸目标距离（像素，tile-units 归一化后的形态）。 */
  fleeGoalDistance: number;
}

/** 默认值（按 tile 尺寸派生：0.35 格判定半径、8 格逃逸距离、1 秒重算、16384 节点）。 */
export function createDefaultPathfindingConfig(tilePx: number): PathfindingConfig {
  return {
    enabled: true,
    repathTicks: 20,
    maxNodes: 16384,
    waypointTolerance: 0.35 * tilePx,
    fleeGoalDistance: 8 * tilePx,
  };
}

/** 16px tile 的基线默认值（仅文档/测试参考；运行时按 world 的 tile 尺寸派生）。 */
export const DEFAULT_PATHFINDING_CONFIG: Readonly<PathfindingConfig> = Object.freeze(
  createDefaultPathfindingConfig(16),
);

/** 按节点/全局覆盖的部分配置。 */
export type PathfindingConfigOverrides = Partial<PathfindingConfig>;

/** world.systemRuntimes 中的全局配置缓存键。 */
const CONFIG_CACHE_KEY = "ai.pathfinding.config";

const CONFIG_KEYS = new Set([
  "enabled",
  "repathTicks",
  "maxNodes",
  "waypointTolerance",
  "fleeGoalDistance",
]);

function asRecord(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, source: string, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${source}.${field}: expected a positive integer, got ${String(value)}`);
  }
  return value;
}

function positiveNumber(value: unknown, source: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${source}.${field}: expected a positive number, got ${String(value)}`);
  }
  return value;
}

/**
 * 解析一段寻路配置（对象，或 `false`/`true` 简写）。
 *
 * @param value 原始配置值（tile-units 归一化后的形态）
 * @param source 错误信息中的来源（如 `Chase args.pathfinding`）
 * @returns 已校验的覆盖项（只含出现的字段）
 */
export function parsePathfindingConfigValue(
  value: unknown,
  source: string,
): PathfindingConfigOverrides {
  if (value === false) return { enabled: false };
  if (value === true) return { enabled: true };

  const raw = asRecord(value, source);
  const overrides: PathfindingConfigOverrides = {};

  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`${source}: unknown pathfinding option "${key}"`);
    }
  }

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") {
      throw new Error(`${source}.enabled: expected a boolean`);
    }
    overrides.enabled = raw.enabled;
  }
  if (raw.repathTicks !== undefined) {
    overrides.repathTicks = positiveInteger(raw.repathTicks, source, "repathTicks");
  }
  if (raw.maxNodes !== undefined) {
    overrides.maxNodes = positiveInteger(raw.maxNodes, source, "maxNodes");
  }
  if (raw.waypointTolerance !== undefined) {
    overrides.waypointTolerance = positiveNumber(
      raw.waypointTolerance,
      source,
      "waypointTolerance",
    );
  }
  if (raw.fleeGoalDistance !== undefined) {
    overrides.fleeGoalDistance = positiveNumber(
      raw.fleeGoalDistance,
      source,
      "fleeGoalDistance",
    );
  }

  return overrides;
}

/** 解析行为树节点参数里的 `args.pathfinding`（工厂创建期调用，尽早抛错）。 */
export function parseActionPathfindingArg(
  value: unknown,
  actionName: string,
): PathfindingConfigOverrides {
  if (value === undefined) return {};
  return parsePathfindingConfigValue(value, `${actionName} args.pathfinding`);
}

/** 读取并缓存全局（ai 系统 config.pathfinding）配置。 */
function globalPathfindingConfig(world: GameWorld): PathfindingConfig {
  const cached = world.systemRuntimes.get(CONFIG_CACHE_KEY) as PathfindingConfig | undefined;
  if (cached) return cached;

  const tilePx = world.gameDef.world?.tile?.width ?? 16;
  const aiEntry = (world.gameDef.systems ?? []).find(
    (entry) => entry.id === "ai" && entry.enabled !== false,
  );
  const raw = aiEntry?.config?.pathfinding;
  const overrides =
    raw === undefined
      ? {}
      : parsePathfindingConfigValue(raw, "game.json systems[ai].config.pathfinding");
  const config: PathfindingConfig = { ...createDefaultPathfindingConfig(tilePx), ...overrides };
  world.systemRuntimes.set(CONFIG_CACHE_KEY, config);
  return config;
}

/** 全局配置 + 节点覆盖（节点字段优先）；结果按 world 缓存全局部分。 */
export function resolvePathfindingConfig(
  world: GameWorld,
  overrides?: PathfindingConfigOverrides,
): PathfindingConfig {
  const base = globalPathfindingConfig(world);
  return overrides && Object.keys(overrides).length > 0 ? { ...base, ...overrides } : base;
}
