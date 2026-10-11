/**
 * 通用状态机组件与配置编译（framework/simulation/stateMachine）——游戏无关。
 *
 * 设计意图：把「会自己变回去的过程」（资源再生、农业生长、腐坏、生命周期）
 * 从硬编码的计时逻辑提升为**配置驱动的状态机**。状态图完全由 game/ 配置声明
 * （实体原型的 `StateMachine` 组件块），框架只按「当前状态 + 进入 tick + 迁移
 * 声明」通用地推进，**不解释任何具体状态语义**——状态 id、信号 id、条件名
 * 全来自配置字符串。
 *
 * ## 数据模型
 *
 * - 持久 AoS 组件 `StateMachine[eid] = { state, enteredTick }`：只存「当前状态
 *   id」与「进入该状态的绝对 tick」。它是世界状态（不是瞬态），随实体入档。
 *   恢复路径 = spawnEntity 的初始化钩子写初始状态 → worldSerializer.applyEntityState
 *   用存档值整体覆写；**不入 netSync**（服务端权威，客户端不需要状态机内部态）。
 * - 状态图 `CompiledStateMachine` 由原型配置编译而来，运行时经 WeakMap 按配置
 *   对象缓存（不落盘、不进 AoS）；恢复后按实体 kind → 原型配置重新解析。
 *
 * ## 迁移声明（每条迁移恰好声明一种触发方式）
 *
 * - `afterTicks`：进入当前状态后经过 N tick（绝对 `enteredTick + afterTicks`
 *   到点）——**定时迁移**。绝对对齐派生保证离线快进与逐 tick 等价。
 * - `on`：外部**即时信号** id（采集等动作经 `signalStateMachine` 发出）。
 * - `condition`：`spawnConditions` 注册表条件名（每 tick 求值）——**条件迁移**。
 *
 * 每条迁移可带 `effects`（EffectSpec[]），在**进入目标状态时**以实体自身为
 * 来源与目标求值一次（如 `restore-resource` 回满资源剩余量）。
 *
 * ## 合法性约束（编译期 fail-fast）
 *
 * - 必须声明非空 `initial`，且它必须在 `states` 中；
 * - 每条迁移的 `to` 必须指向已声明状态；
 * - 恰好声明一种触发方式；`afterTicks` 为非负整数；`condition` 必须已注册；
 * - **自动迁移子图（定时 + 条件边）必须无环**——否则离线快进无法在有限步内
 *   收敛（信号边不参与，故「采集→再生→可采集」的合理环不受影响）。
 */
import { Kind } from "framework/components/kind";
import { parseEffectSpec, type EffectSpec } from "framework/simulation/effects/effectRegistry";
import { hasSpawnCondition } from "framework/systems/gameplay/spawnConditions";
import type { GameWorld } from "framework/world";

/** 当前状态 + 进入该状态的绝对 tick（持久 AoS 组件）。 */
export interface StateMachineState {
  /** 当前状态 id（配置字符串；框架只当不透明标识）。 */
  state: string;
  /** 进入当前状态的绝对 tick（world.time.tick）。 */
  enteredTick: number;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const StateMachine = [] as (StateMachineState | undefined)[];

/**
 * 内建即时信号名（通用机制词，非游戏名词）——采集链路在资源节点状态变化时发出。
 * 具体状态迁移由 game/ 配置按同名 `on` 声明。
 */
export const FSM_SIGNAL_HARVESTED = "harvested";
export const FSM_SIGNAL_DEPLETED = "depleted";

/** 迁移触发方式：定时 / 即时信号 / 条件。 */
export type TransitionKind = "timed" | "signal" | "condition";

/** 编译后的单条迁移（字段均为通用机制语义）。 */
export interface CompiledTransition {
  /** 目标状态 id。 */
  to: string;
  /** 触发方式。 */
  kind: TransitionKind;
  /** 定时迁移的延迟 tick（kind === "timed"）。 */
  afterTicks?: number;
  /** 即时信号 id（kind === "signal"）。 */
  signal?: string;
  /** 条件名（kind === "condition"；spawnConditions 注册表引用）。 */
  condition?: string;
  /** 进入目标状态时求值的效果引用。 */
  effects: EffectSpec[];
}

/** 编译后的单个状态。 */
export interface CompiledState {
  transitions: CompiledTransition[];
}

/** 编译后的状态图（runtime-only；不由配置直接持有）。 */
export interface CompiledStateMachine {
  initial: string;
  states: Map<string, CompiledState>;
}

/** 编译缓存：按原型配置对象身份记忆（配置对象在 spawn 间稳定）。 */
const defCache = new WeakMap<object, CompiledStateMachine>();

/** 运行时状态图索引：eid → 编译后的状态图（不落盘；恢复/重生成后由 init/attach 重建）。 */
const runtimeDefs = [] as (CompiledStateMachine | undefined)[];

/**
 * 编译状态机配置为运行时状态图（纯函数 + 按配置对象身份缓存）。
 * 配置非法时抛错（消息以 `StateMachine config:` 前缀点名具体字段）。
 */
export function compileStateMachine(config: unknown): CompiledStateMachine {
  if (config && typeof config === "object") {
    const cached = defCache.get(config as object);
    if (cached) return cached;
  }
  const def = buildCompiledStateMachine(config);
  if (config && typeof config === "object") defCache.set(config as object, def);
  return def;
}

/** 实际编译逻辑（不含缓存）。 */
function buildCompiledStateMachine(config: unknown): CompiledStateMachine {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("StateMachine config: must be an object with { initial, states }");
  }
  const raw = config as Record<string, unknown>;

  const initial = raw.initial;
  if (typeof initial !== "string" || initial === "") {
    throw new Error('StateMachine config: missing non-empty "initial" state id');
  }

  const statesRaw = raw.states;
  if (!statesRaw || typeof statesRaw !== "object" || Array.isArray(statesRaw)) {
    throw new Error('StateMachine config: missing non-empty "states" object');
  }
  const stateEntries = Object.entries(statesRaw as Record<string, unknown>);
  if (stateEntries.length === 0) {
    throw new Error('StateMachine config: "states" must declare at least one state');
  }

  const states = new Map<string, CompiledState>();
  for (const [stateId, stateRaw] of stateEntries) {
    if (stateId === "") {
      throw new Error("StateMachine config: state ids must be non-empty strings");
    }
    states.set(stateId, compileState(stateId, stateRaw));
  }

  if (!states.has(initial)) {
    throw new Error(
      `StateMachine config: initial state "${initial}" is not declared in states ` +
        `(declared: ${[...states.keys()].join(", ")})`,
    );
  }

  // 目标状态引用校验（先全部建成 Map 再查）
  for (const [stateId, state] of states) {
    for (const transition of state.transitions) {
      if (!states.has(transition.to)) {
        throw new Error(
          `StateMachine config: state "${stateId}" transition targets unknown state "${transition.to}"`,
        );
      }
    }
  }

  assertAcyclicAutomatic(states);
  return { initial, states };
}

/** 编译单个状态（transitions 缺省为空数组）。 */
function compileState(stateId: string, stateRaw: unknown): CompiledState {
  if (!stateRaw || typeof stateRaw !== "object" || Array.isArray(stateRaw)) {
    throw new Error(`StateMachine config: state "${stateId}" must be an object`);
  }
  const transitionsRaw = (stateRaw as Record<string, unknown>).transitions;
  if (transitionsRaw === undefined) return { transitions: [] };
  if (!Array.isArray(transitionsRaw)) {
    throw new Error(`StateMachine config: state "${stateId}" transitions must be an array`);
  }
  return {
    transitions: transitionsRaw.map((t, index) => compileTransition(stateId, index, t)),
  };
}

/** 编译单条迁移：校验「恰好一种触发方式」与字段合法性。 */
function compileTransition(stateId: string, index: number, raw: unknown): CompiledTransition {
  const where = `state "${stateId}" transition #${index}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`StateMachine config: ${where} must be an object`);
  }
  const obj = raw as Record<string, unknown>;

  const to = obj.to;
  if (typeof to !== "string" || to === "") {
    throw new Error(`StateMachine config: ${where} requires a non-empty "to" state id`);
  }

  const hasTimed = obj.afterTicks !== undefined;
  const hasSignal = obj.on !== undefined;
  const hasCondition = obj.condition !== undefined;
  const triggerCount = (hasTimed ? 1 : 0) + (hasSignal ? 1 : 0) + (hasCondition ? 1 : 0);
  if (triggerCount !== 1) {
    throw new Error(
      `StateMachine config: ${where} must declare exactly one of "afterTicks" / "on" / "condition"`,
    );
  }

  const transition: CompiledTransition = { to, kind: "signal", effects: parseEffects(obj.effects) };

  if (hasTimed) {
    const afterTicks = obj.afterTicks;
    if (typeof afterTicks !== "number" || !Number.isInteger(afterTicks) || afterTicks < 0) {
      throw new Error(`StateMachine config: ${where} "afterTicks" must be a non-negative integer`);
    }
    transition.kind = "timed";
    transition.afterTicks = afterTicks;
    return transition;
  }

  if (hasSignal) {
    const on = obj.on;
    if (typeof on !== "string" || on === "") {
      throw new Error(`StateMachine config: ${where} "on" must be a non-empty signal id`);
    }
    transition.kind = "signal";
    transition.signal = on;
    return transition;
  }

  const condition = obj.condition;
  if (typeof condition !== "string" || condition === "") {
    throw new Error(`StateMachine config: ${where} "condition" must be a non-empty condition name`);
  }
  if (!hasSpawnCondition(condition)) {
    throw new Error(`StateMachine config: ${where} references unknown condition "${condition}"`);
  }
  transition.kind = "condition";
  transition.condition = condition;
  return transition;
}

/** 解析 effects 数组（结构非法项跳过——与 Triggers 的宽松解析一致）。 */
function parseEffects(raw: unknown): EffectSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: EffectSpec[] = [];
  for (const item of raw) {
    const spec = parseEffectSpec(item);
    if (spec) out.push(spec);
  }
  return out;
}

/**
 * 自动迁移子图（定时 + 条件边）无环校验：有环则离线快进无法在有限步内收敛
 * （信号边不参与——「采集→再生→可采集」由外部信号驱动，属合理环）。
 * 环消息点名路径（a → b → a）。
 */
function assertAcyclicAutomatic(states: Map<string, CompiledState>): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    color.set(id, GRAY);
    stack.push(id);
    for (const transition of states.get(id)!.transitions) {
      if (transition.kind === "signal") continue; // 信号边不由快进消费
      const nextColor = color.get(transition.to) ?? WHITE;
      if (nextColor === GRAY) {
        const start = stack.indexOf(transition.to);
        const cycle = [...stack.slice(start), transition.to].join(" → ");
        throw new Error(`StateMachine config: automatic transitions form a cycle (${cycle})`);
      }
      if (nextColor === WHITE) visit(transition.to);
    }
    stack.pop();
    color.set(id, BLACK);
  };

  for (const id of states.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) visit(id);
  }
}

/** 读世界当前 tick（world 形态宽松——初始化钩子对 world 泛化）。 */
function tickOf(world: unknown): number {
  const time = (world as { time?: { tick?: unknown } } | undefined)?.time;
  return typeof time?.tick === "number" ? time.tick : 0;
}

/**
 * AoS archetype 初始化钩子：按原型配置编译状态图，写入初始状态与进入 tick
 * （= world.time.tick，即生成时刻）。配置非法时抛错（开机/生成期 fail-fast）。
 */
export function initStateMachine(world: unknown, eid: number, config: unknown): void {
  const def = compileStateMachine(config);
  runtimeDefs[eid] = def;
  StateMachine[eid] = { state: def.initial, enteredTick: tickOf(world) };
}

/**
 * 取实体的编译状态图：优先运行时索引（init/attach 写入），回退按 kind 查原型
 * 配置并编译（恢复/手工 spawn 的兜底）。返回 undefined 表示实体无状态机配置。
 */
export function stateMachineDefOf(world: GameWorld, eid: number): CompiledStateMachine | undefined {
  const direct = runtimeDefs[eid];
  if (direct) return direct;
  if (!StateMachine[eid]) return undefined;

  const kind = Kind[eid];
  const archetype = kind ? world.archetypes.get(kind) : undefined;
  const config = archetype?.components?.["StateMachine"];
  if (config === undefined) return undefined;

  const def = compileStateMachine(config);
  runtimeDefs[eid] = def;
  return def;
}

/**
 * 运行时挂载状态机（测试/程序化 spawn 入口）：编译配置、写初始状态与进入 tick。
 * 与 initStateMachine 等价，但显式接收 world 与可选 enteredTick。
 */
export function attachStateMachine(
  world: GameWorld,
  eid: number,
  config: unknown,
  enteredTick?: number,
): void {
  const def = compileStateMachine(config);
  runtimeDefs[eid] = def;
  StateMachine[eid] = { state: def.initial, enteredTick: enteredTick ?? world.time.tick };
}
