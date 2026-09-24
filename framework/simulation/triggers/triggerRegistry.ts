/**
 * 触发器注册表——「触发器名 → 求值器」的工厂表（注册模式对齐 action/ruleModule）。
 *
 * 触发器求值器在对应类型化事件发生时（经事件总线，triggerSystem 固定阶段
 * 消费）执行挂载在触发实体上的效果列表。事件载荷约定携带 owner eid（字段
 * `eid`）与可选目标（字段 `target`），求值器据此确定效果来源与缺省目标。
 *
 * 内建求值器采用统一的「实体事件」实现：owner = 载荷 eid、target = 载荷
 * target（缺省 owner），效果列表经 effectRegistry 依次求值。本阶段闭环：
 * on-timer（timerSystem 供事件）与 on-command（GameSimulation 供事件）；
 * on-hit / on-contact / on-region-* 的产生方接线留配方切片（on-contact 已有
 * projectileSystem 供事件，可直接消费）。
 */
import type { GameWorld, EntityId } from "framework/world";
import { applyEffectSpecs, positionOfEntity } from "framework/simulation/effects/effectRegistry";
import type { EffectSpec } from "framework/simulation/effects/effectRegistry";
import type { RegistrationMetadata } from "framework/registryMetadata";
import { assertStrictConfigSchema } from "framework/registryMetadata";

/** 触发器求值上下文。 */
export interface TriggerContext {
  /** 触发源实体（挂载 Triggers 的实体）。 */
  owner: EntityId;
  /** 命中的事件载荷（结构由事件名约定）。 */
  payload: unknown;
  /** 效果缺省目标：事件载荷 target 优先，回退 owner。 */
  target: EntityId;
  /** ECS world（运行时注入）。 */
  world: GameWorld;
}

/** 触发器求值器：对命中的效果列表执行一次。 */
export type TriggerEvaluator = (ctx: TriggerContext, effects: EffectSpec[]) => void;

/** 触发器注册条目（含可选元数据），供配置编辑器消费。 */
export interface TriggerEvaluatorEntry extends RegistrationMetadata {
  /** 触发器注册名（= 类型化事件名）。 */
  name: string;
  /** 触发器求值器。 */
  evaluator: TriggerEvaluator;
}

/** 注册表：触发器名 → 注册条目（模块级单例，bootstrap 时注册内建实现）。 */
const evaluators = new Map<string, TriggerEvaluatorEntry>();

/** 注册触发器求值器；同名重复注册抛错（防静默覆盖）。可选元数据随条目保存供编辑器消费。 */
export function registerTrigger(
  name: string,
  evaluator: TriggerEvaluator,
  meta?: RegistrationMetadata,
): void {
  if (evaluators.has(name)) {
    throw new Error(`Trigger "${name}" is already registered`);
  }
  assertStrictConfigSchema(name, meta?.configSchema);
  evaluators.set(name, { name, evaluator, ...meta });
}

/** 按名取求值器；未注册返回 undefined（triggerSystem 跳过该事件）。 */
export function getTrigger(name: string): TriggerEvaluator | undefined {
  return evaluators.get(name)?.evaluator;
}

/** 触发器名是否已注册。 */
export function hasTrigger(name: string): boolean {
  return evaluators.has(name);
}

/** 列出全部已注册触发器名（注册序）。 */
export function listTriggers(): string[] {
  return [...evaluators.keys()];
}

/** 列出全部已注册触发器条目（含 description / configSchema），供 sidecar listRegistries 消费。 */
export function listTriggerEntries(): TriggerEvaluatorEntry[] {
  return [...evaluators.values()];
}

/** 内建求值器（通用实体事件）：效果以 owner 为来源、target 为缺省目标执行。 */
function entityEventEvaluator(ctx: TriggerContext, effects: EffectSpec[]): void {
  applyEffectSpecs(
    ctx.world,
    ctx.owner,
    [ctx.target],
    effects,
    positionOfEntity(ctx.world, ctx.owner),
  );
}

/** 内建触发器名（= 类型化事件名；产生方接线的完整度见文件头注释）。 */
const BUILTIN_TRIGGER_NAMES = [
  "on-timer",
  "on-command",
  "on-hit",
  "on-contact",
  "on-death",
  "on-region-enter",
  "on-region-clear",
] as const;

/** 注册全部内建触发器求值器（bootstrap 时调用一次；重复注册抛错）。 */
export function registerBuiltinTriggers(): void {
  for (const name of BUILTIN_TRIGGER_NAMES) {
    registerTrigger(name, entityEventEvaluator);
  }
}
