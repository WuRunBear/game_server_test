import type { GameWorld } from "framework/world";
import { query } from "bitecs";
import { NetworkId } from "framework/components/network";
import type { ActionDefinition } from "framework/config/schema/ActionSchema";

/**
 * 动作时间轴运行时状态（AoS）。
 *
 * 这是**服务端权威的瞬态状态**：动作开始写、每 tick 推进、结束/打断清空。
 * 不是 bitecs 组件（普通 JS 数组按 eid 索引），因此：
 * - 不进 archetype 初始化（动作永远由输入/命令启动）；
 * - 不进存档（`Action` 走 netSync 派生投影，不注册持久组件）；
 * - eid 只在服务端内部使用，对外同步由 adapters 转成 networkId。
 *
 * 时间基一律为 tick：`startedTick` / `durationTicks` / `phaseIndex` 与
 * `world.time.tick` 同基，不混用毫秒。
 */
export interface ActionStateEntry {
  /** 动作 id（引用 actions 配置；配置字符串是不透明标识）。 */
  actionId: string;
  /** 动作开始的世界 tick（客户端动画进度基准）。 */
  startedTick: number;
  /** 动作总时长（tick）。 */
  durationTicks: number;
  /** 当前阶段索引（0 起；动作开始时为首阶段）。 */
  phaseIndex: number;
  /** 当前阶段 id（同步给客户端）。 */
  phase: string;
  /**
   * 已触发过事件的阶段索引（内部游标，-1 = 尚未触发任何阶段事件）。
   * 与 phaseIndex 分离：动作开始时即处于首阶段，但首阶段事件仍由 actionSystem
   * 在首次推进时触发一次（同 tick 不重复）。
   */
  eventsThroughPhase: number;
  /** 解析后的目标实体 eid（-1 = 无目标）。对外同步时转 networkId。 */
  targetEid: number;
  /**
   * 目标解析时的 networkId（内部防 eid 复用串台：事件阶段复核目标仍是同一
   * 网络实体；对外同步仍按当前 targetEid 的 NetworkId 读取，不输出 eid）。
   */
  targetNetworkId?: number;
  /** 朝向单位向量 x（由目标/瞄准/移动输入得出，不依赖 Transform.rot）。 */
  dirX: number;
  /** 朝向单位向量 y。 */
  dirY: number;
  /** 动作期间是否锁移动（来自配置）。 */
  locked: boolean;
  /** 是否可被新动作打断（来自配置）。 */
  interruptible: boolean;
  /** 目标是否已解析（最近目标回退也算 true；无目标 false）。 */
  resolved: boolean;
  /** 动作开始时的地图 id（换图即取消）。 */
  mapId: string;
  /** 动作开始时的生命值（cancelOnDamage 比较基准）。 */
  startHealth: number;
  /** 受击是否取消（来自配置）。 */
  cancelOnDamage: boolean;
  /** 动作开始时是否真的写入了 Cooldown（配置了 cooldownTicks 且有组件）。 */
  cooldownStarted: boolean;
  /** 事件阶段调用既有原子时使用的交互距离（可选；gather 复核目标是否仍在范围内）。 */
  maxRange?: number;
  /** 投掷瞄准点（世界坐标；仅 spawn-projectile 事件使用）。 */
  aimX?: number;
  /** 投掷瞄准点（世界坐标）。 */
  aimY?: number;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件）。 */
export const ActionState = [] as (ActionStateEntry | undefined)[];

/**
 * 单帧动作输入载荷（可选目标/瞄准）。
 *
 * GameSimulation.applyInputs 在 attack/interact 输入帧写入；interactionSystem
 * 消费并清空。`target` 是 networkId（协议层可见标识），interactionSystem 解析
 * 为 eid 后写入 ActionState.targetEid。
 */
export interface ActionInputState {
  /** 目标实体 networkId（可选；解析失败时回退最近目标）。 */
  target?: number;
  /** 瞄准点世界坐标 x（可选；投掷/朝向回退）。 */
  aimX?: number;
  /** 瞄准点世界坐标 y。 */
  aimY?: number;
}

/** AoS 存储：按 eid 索引的待消费动作输入。 */
export const ActionInput = [] as (ActionInputState | undefined)[];

/** netSync 派生投影伪组件名（同步键空间 `Action.*`）。 */
export const ACTION_SYNC_COMPONENT = "Action";

/** 运行时动作配置：动作 id → 定义 + 意图名 → 动作 id 映射。 */
export interface ActionRuntime {
  /** 动作定义表（键为配置中的动作 id）。 */
  actions: Map<string, ActionDefinition>;
  /** 意图名 → 动作 id（如 attack/interact/throw）。 */
  intentActions: Record<string, string>;
}

/**
 * 每 world 的动作运行时配置。
 *
 * actionSystem 工厂在装配期写；interactionSystem / GameSimulation 在运行期读。
 * WeakMap 保证不同仿真世界（测试/多实例）互不串配置。
 */
const actionRuntimes = new WeakMap<GameWorld, ActionRuntime>();

/** 注册/替换 world 的动作运行时（重复注册覆盖；null 清除）。 */
export function setActionRuntime(world: GameWorld, runtime: ActionRuntime | undefined): void {
  if (runtime) actionRuntimes.set(world, runtime);
  else actionRuntimes.delete(world);
}

/** 取 world 的动作运行时；未配置时 undefined（调用方回退旧瞬时行为）。 */
export function getActionRuntime(world: GameWorld): ActionRuntime | undefined {
  return actionRuntimes.get(world);
}

/** 按动作 id 取定义；无运行时/未配置返回 undefined。 */
export function getActionDefinition(world: GameWorld, actionId: string): ActionDefinition | undefined {
  return actionRuntimes.get(world)?.actions.get(actionId);
}

/**
 * 意图名 → 已配置动作 id。
 *
 * 运行时缺失或映射目标未配置时返回 undefined——调用方据此保持旧瞬时路径，
 * 避免半配置状态下启用动作时间轴。
 */
export function getIntentActionId(world: GameWorld, intent: string): string | undefined {
  const runtime = actionRuntimes.get(world);
  if (!runtime) return undefined;
  const actionId = runtime.intentActions[intent];
  if (!actionId || !runtime.actions.has(actionId)) return undefined;
  return actionId;
}

/** 清空实体的动作状态（结束/死亡/换图/打断/断线）。 */
export function clearActionState(eid: number): void {
  ActionState[eid] = undefined;
}

/** 消费并清空实体的待处理动作输入（interactionSystem 每个意图只读一次）。 */
export function takeActionInput(eid: number): ActionInputState | undefined {
  const input = ActionInput[eid];
  ActionInput[eid] = undefined;
  return input;
}

/** 把方向向量归一化；零向量回退 +x（与投掷缺省朝向一致）。 */
export function normalizeDirection(x: number, y: number): { x: number; y: number } {
  const len = Math.hypot(x, y);
  if (!Number.isFinite(len) || len <= 1e-6) return { x: 1, y: 0 };
  return { x: x / len, y: y / len };
}

/** 当前相对 tick 所处阶段索引（阶段区间 [prevEnd, endTick)）。 */
export function phaseIndexAt(definition: ActionDefinition, elapsedTicks: number): number {
  let index = 0;
  const phases = definition.phases;
  while (index + 1 < phases.length && elapsedTicks >= phases[index]!.endTick) {
    index += 1;
  }
  return index;
}

/** 阶段 id（越界回退空串）。 */
export function phaseIdAt(definition: ActionDefinition, index: number): string {
  return definition.phases[index]?.id ?? "";
}

/**
 * networkId → eid 反查（协议层只见 networkId；只认当前存在且带 NetworkId 的实体）。
 *
 * 目标解析失败（伪造/已销毁/从未存在）返回 undefined，调用方回退最近目标或
 * 朝向前方——任何同步 key 都不会暴露 eid。
 */
export function findEidByNetworkId(world: GameWorld, networkId: number | undefined): number | undefined {
  if (typeof networkId !== "number" || !Number.isInteger(networkId) || networkId <= 0) return undefined;
  for (const eid of query(world, [NetworkId])) {
    if (NetworkId.value[eid] === networkId) return eid;
  }
  return undefined;
}
