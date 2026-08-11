import type { System, GameWorld } from "framework/world";

/**
 * 系统注册表与构建器：把「系统名 → 工厂函数」的注册表（名 → factory 模式）
 * 与 game.json 中启用的系统列表结合，按依赖顺序实例化出每 tick 运行的系统链。
 *
 * 关键机制：
 * - 注册表：registerSystem() 把系统名与工厂函数登记进注册表，配置只按 id 引用系统
 * - 构建：buildSystems(world, enabled) 读取 game.json 的 systems[]（即 enabled 参数），
 *   解析 after/before 依赖做拓扑排序，按序调用工厂生成系统实例
 * - 系统链：每个系统都是 (world) => world 的纯函数，由 GameSimulation 按序串联执行，
 *   上一个系统处理后的 world 原样传给下一个系统，形成一条无状态的管道
 */
export interface SystemSpec {
  /** 系统唯一 id，与 game.json 的 systems[].id 对应。 */
  id: string;
  /** 工厂函数：传入 world（及可选配置）返回系统实例（即 (world) => world）。 */
  factory: (world: GameWorld, config?: Record<string, unknown>) => System;
  /** 依赖声明：本系统应在本列表中的系统之后运行。 */
  after?: string[];
  /** 依赖声明：本系统应在本列表中的系统之前运行。 */
  before?: string[];
  /** 默认排序权重（保留字段，未显式依赖时仍以注册顺序为准）。 */
  defaultOrder?: number;
}

/** 系统注册表接口：名 → SystemSpec 的映射，提供注册、查询与枚举。 */
export interface SystemRegistry {
  /** 注册系统；同名重复注册会抛错，防止静默覆盖。 */
  register(spec: SystemSpec): void;
  /** 按 id 取系统定义；不存在时抛错（尽早暴露配置拼写错误）。 */
  get(id: string): SystemSpec;
  /** 判断某 id 是否已注册。 */
  has(id: string): boolean;
  /** 返回全部系统定义的快照（按注册顺序）。 */
  all(): SystemSpec[];
}

/** 创建系统注册表（内部用 Map 实现，保持注册顺序）。 */
export function createSystemRegistry(): SystemRegistry {
  const systems = new Map<string, SystemSpec>();

  return {
    register(spec) {
      if (systems.has(spec.id)) {
        throw new Error(`System "${spec.id}" is already registered`);
      }
      systems.set(spec.id, spec);
    },

    get(id) {
      const spec = systems.get(id);
      if (!spec) {
        throw new Error(`System "${id}" is not registered`);
      }
      return spec;
    },

    has(id) {
      return systems.has(id);
    },

    all() {
      return [...systems.values()];
    },
  };
}

/** game.json 中 systems[] 的单个条目：启用开关 + 可选配置（对应 SystemSpec.id）。 */
interface SystemEnableEntry {
  id: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/**
 * 对系统做拓扑排序：解析 after/before 依赖，输出满足顺序要求的执行序列。
 *
 * 算法：以系统为节点、依赖为有向边构建 DAG，用 Kahn 算法（入度归零先出队）排序。
 * - after：s.after 里列出的系统应在 s 之前跑，即 s 依赖它们
 * - before：s.before 里列出的系统应在 s 之后跑，等价于给那些系统追加一条对 s 的依赖边
 * - 未显式声明依赖的系统保持注册顺序（同入度按注册序出队）
 * @param specs 待排序的系统定义（已过滤未启用的系统）
 * @returns 满足依赖顺序的执行序列
 */
function topologicalSort(specs: SystemSpec[]): SystemSpec[] {
  const graph = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const s of specs) {
    const deps: string[] = [];
    if (s.after) deps.push(...s.after);
    graph.set(s.id, deps);
    inDegree.set(s.id, 0);
  }

  for (const [id, deps] of graph) {
    for (const dep of deps) {
      if (inDegree.has(dep)) {
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      }
    }
  }

  // "before" 语义：b 应在 s 之后跑（b 依赖 s），故给 b 增加一条 s 的依赖边。
  // 去重避免与 after 共同产生重复边；缺失的 b 静默忽略（与 after 行为一致）。
  for (const s of specs) {
    if (!s.before) continue;
    for (const b of s.before) {
      if (!inDegree.has(b)) continue;
      const bDeps = graph.get(b)!;
      if (!bDeps.includes(s.id)) {
        bDeps.push(s.id);
        inDegree.set(b, (inDegree.get(b) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  const result: SystemSpec[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const spec = specs.find((s) => s.id === id)!;
    result.push(spec);

    for (const [otherId, deps] of graph) {
      if (deps.includes(id)) {
        const newDegree = (inDegree.get(otherId) ?? 1) - 1;
        inDegree.set(otherId, newDegree);
        if (newDegree === 0) queue.push(otherId);
      }
    }
  }

  return result;
}

/**
 * 依据 game.json 的 systems[] 配置构建每 tick 运行的系统链。
 *
 * 流程：
 * 1. 过滤 enabled !== false 的条目（默认启用）
 * 2. 逐个校验 id 已注册（未注册直接抛错，尽早暴露配置错误）
 * 3. 收集系统定义与 per-system config，按依赖做拓扑排序
 * 4. 按序调用 factory(world, config) 实例化，返回系统函数数组
 *
 * 返回的系统链由调用方（GameSimulation）按数组顺序执行：
 * 每个系统形如 (world) => world，前一个系统的返回值即后一个系统的入参。
 *
 * @param world 目标 ECS World（传给各工厂函数）
 * @param enabled game.json 中 systems[] 的启用列表（顺序即配置书写顺序）
 * @param registry 系统注册表；缺省时用 world.systems_registry
 * @returns 已按依赖排序实例化的系统函数数组
 */
export function buildSystems(
  world: GameWorld,
  enabled: SystemEnableEntry[],
  registry?: SystemRegistry,
): System[] {
  const reg = registry ?? (world.systems_registry as unknown as SystemRegistry);
  const enabledIds = new Set(
    enabled.filter((e) => e.enabled !== false).map((e) => e.id),
  );

  const specs: SystemSpec[] = [];
  const configs = new Map<string, Record<string, unknown>>();
  for (const entry of enabled) {
    if (!reg.has(entry.id)) {
      throw new Error(`System "${entry.id}" is not registered`);
    }
    const spec = reg.get(entry.id);
    if (enabledIds.has(spec.id)) {
      specs.push(spec);
      if (entry.config) {
        configs.set(spec.id, entry.config);
      }
    }
  }

  const ordered = topologicalSort(specs);
  return ordered.map((s) => s.factory(world, configs.get(s.id)));
}
