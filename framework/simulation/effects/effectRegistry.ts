/**
 * 效果注册表——「效果名 → 执行器」的工厂表（注册模式对齐 action/ruleModule）。
 *
 * 效果（Effect）是服务端权威的最小动作单元：定时器、触发器、命令通道
 * 等入口都经效果名 + 参数引用执行（EffectSpec 声明式引用）。执行器签名
 * 统一为 (ctx) => boolean：返回是否产生实际作用，供调用方聚合判定。
 *
 * 游戏无关——效果名与参数全为通用机制词，具体语义由 game/ 配置约定。
 */
import { hasComponent } from "bitecs";
import type { GameWorld, EntityId } from "framework/world";
import { Transform } from "framework/components/transform";

/**
 * 效果执行上下文：来源实体、目标实体列表、作用位置与声明参数。
 */
export interface EffectContext {
  /** 效果来源实体（伤害事件归因、召唤定位等）。 */
  source: EntityId;
  /** 效果目标实体列表（声明式入口缺省为 [owner]，可被载荷 target 覆盖）。 */
  targets: EntityId[];
  /** 作用位置（缺省由各效果自定，如回退来源实体位置）。 */
  position?: { x: number; y: number };
  /** 效果参数（EffectSpec.params 透传，效果实现按名取用）。 */
  params: Record<string, unknown>;
  /** ECS world（运行时注入，执行器经 world 访问组件与注册表）。 */
  world: GameWorld;
}

/** 效果执行器：执行一次效果，返回是否产生实际作用。 */
export type EffectExecutor = (ctx: EffectContext) => boolean;

/** 效果引用（声明式形态）：效果名 + 可选参数。 */
export interface EffectSpec {
  /** 效果名（effectRegistry 注册名）。 */
  name: string;
  /** 效果参数（透传给执行器的 ctx.params）。 */
  params?: Record<string, unknown>;
}

/** 注册表：效果名 → 执行器（模块级单例，bootstrap 时注册内建实现）。 */
const effects = new Map<string, EffectExecutor>();

/** 注册效果执行器；同名重复注册抛错（防静默覆盖）。 */
export function registerEffect(name: string, executor: EffectExecutor): void {
  if (effects.has(name)) {
    throw new Error(`Effect "${name}" is already registered`);
  }
  effects.set(name, executor);
}

/** 按名取效果执行器；未注册返回 undefined（调用方告警跳过，不崩 tick）。 */
export function getEffect(name: string): EffectExecutor | undefined {
  return effects.get(name);
}

/** 效果名是否已注册。 */
export function hasEffect(name: string): boolean {
  return effects.has(name);
}

/** 列出全部已注册效果名（注册序）。 */
export function listEffects(): string[] {
  return [...effects.keys()];
}

/**
 * 取实体位置（无 Transform 时 undefined）。
 * 供声明式入口把 ctx.position 缺省到来源实体位置。
 */
export function positionOfEntity(world: GameWorld, eid: EntityId): { x: number; y: number } | undefined {
  if (!hasComponent(world, eid, Transform)) return undefined;
  return { x: Transform.x[eid], y: Transform.y[eid] };
}

/**
 * 按效果引用列表依次执行（声明式入口的统一求值路径）。
 *
 * 未注册的效果名记 warn 并跳过（不崩 tick），返回值聚合为 false。
 *
 * @returns 是否全部效果执行成功（任一失败/缺失即 false）
 */
export function applyEffectSpecs(
  world: GameWorld,
  source: EntityId,
  targets: EntityId[],
  specs: EffectSpec[],
  position?: { x: number; y: number },
): boolean {
  let ok = true;
  for (const spec of specs) {
    const executor = effects.get(spec.name);
    if (!executor) {
      world.logger.warn("效果未注册，跳过", { effect: spec.name, source });
      ok = false;
      continue;
    }
    const ctx: EffectContext = {
      world,
      source,
      targets,
      position,
      params: spec.params ?? {},
    };
    if (!executor(ctx)) ok = false;
  }
  return ok;
}
