/**
 * 通用成长机制：经验 / 等级 / 技能加成（游戏无关）。
 *
 * 数据形态见 components/progression（AoS，随实体自动入档）。本模块只做三件事：
 * 1. **经验推进**：把配置化的经验值累加到 totalXp / 对应技能 xp，并按等级曲线
 *    派生角色等级与技能等级；
 * 2. **技能加成**：把 `skillId → { stat, perLevel, mode }` 映射为通用属性加成
 *    （add：加到基础值；mul：乘在基础值上），由战斗 / 采集等消费方按 stat 名读取；
 * 3. **XP 来源接线**：击杀（原型 `xpValue`/`xpSkill`，本系统 peek 帧内 `killed`
 *    事件——不消费，避免抢走 questSystem 的同批事件）与采集（interactionSystem
 *    在 harvest 成功后调 `awardHarvestXp`，读 ResourceNode 的 `xpValue`/`xpSkill`）。
 *
 * 规则来自 `rules/progression.json`（结构由 RuleSchema 的
 * ProgressionRuleSchema 校验，见 config/schema/RuleSchema.ts；本模块负责
 * 补缺省值与运行期解析）：
 * ```
 * {
 *   "curve": { "baseXp": 100, "growth": 1.5, "maxLevel": 20 },
 *   "skills": {
 *     "combat":    { "stat": "attack",     "perLevel": 2,   "mode": "add" },
 *     "gathering": { "stat": "gatherMult", "perLevel": 0.5, "mode": "mul" }
 *   }
 * }
 * ```
 * 等级 L（1 起）升级所需经验 = round(baseXp × growth^(L-1))；
 * 技能加成 = perLevel × max(0, skillLevel - 1)（1 级为已掌握、无加成）。
 * skillId / stat / xpSkill 的值全部由 game/ 配置约定，框架不解释其语义。
 */
import { ResourceNode, type ResourceNodeState } from "framework/components/resourceNode";
import { Progression, type SkillProgress } from "framework/components/progression";
import { ProgressionRuleSchema } from "framework/config/schema/RuleSchema";
import type { ArchetypeSpec } from "framework/entities/archetypeRegistry";
import type { GameWorld } from "framework/world";
import { emitClientEvent, networkIdOf } from "framework/simulation/clientEvents";

/** 等级曲线：L → L+1 所需经验 = round(baseXp × growth^(L-1))。 */
export interface ProgressionCurve {
  /** 1 → 2 级所需经验（> 0）。 */
  baseXp: number;
  /** 每级阈值增长倍率（≥ 1）。 */
  growth: number;
  /** 等级上限（含；达到后经验继续累计但等级不再增长）。 */
  maxLevel: number;
}

/** 单技能的属性加成映射。 */
export interface SkillBonusRule {
  /** 目标属性名（消费方约定：attack / defense / gatherMult 等；框架只透传）。 */
  stat: string;
  /** 每级（高于 1 级的部分）提供的加成量。 */
  perLevel: number;
  /** 加成方式：add = 加到基础值；mul = 乘在基础值上（1 + perLevel × 等级数）。 */
  mode: "add" | "mul";
}

/** 解析后的成长规则。 */
export interface ProgressionRules {
  curve: ProgressionCurve;
  skills: Record<string, SkillBonusRule>;
}

/** 缺省曲线（未配置 rules/progression.json 时）：100 / 2 / 99。 */
export const DEFAULT_PROGRESSION_CURVE: ProgressionCurve = {
  baseXp: 100,
  growth: 2,
  maxLevel: 99,
};

/** 规则解析缓存（按 rules 对象身份；测试/工具替换规则对象时自动重解析）。 */
const rulesCache = new WeakMap<object, ProgressionRules>();
let rulesWithoutConfig: ProgressionRules | undefined;

/** 配置错误统一出口。 */
function progressionFail(detail: string): never {
  throw new Error(`progression rules: ${detail}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析成长规则（纯函数，非法配置 fail-fast 抛错）。
 *
 * @param raw `rules/progression.json` 的原始内容（缺省/undefined = 无配置）
 */
export function parseProgressionRules(raw: unknown): ProgressionRules {
  if (raw === undefined || raw === null) {
    return { curve: { ...DEFAULT_PROGRESSION_CURVE }, skills: {} };
  }
  if (!isPlainObject(raw)) {
    progressionFail("rule document must be an object");
  }

  // 结构/数值约束的唯一事实来源 = RuleSchema 的 ProgressionRuleSchema
  // （validate 阶段与本模块 fail-fast 共用同一份 schema）；本函数只补缺省值。
  const parsed = ProgressionRuleSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "rule document";
    progressionFail(`${path}: ${issue.message}`);
  }

  const curveRaw = parsed.data.curve ?? {};
  const curve: ProgressionCurve = {
    baseXp: curveRaw.baseXp ?? DEFAULT_PROGRESSION_CURVE.baseXp,
    growth: curveRaw.growth ?? DEFAULT_PROGRESSION_CURVE.growth,
    maxLevel: curveRaw.maxLevel ?? DEFAULT_PROGRESSION_CURVE.maxLevel,
  };

  const skills: Record<string, SkillBonusRule> = {};
  for (const [skillId, skillRaw] of Object.entries(parsed.data.skills ?? {})) {
    skills[skillId] = {
      stat: skillRaw.stat,
      perLevel: skillRaw.perLevel,
      mode: skillRaw.mode ?? "add",
    };
  }

  return { curve, skills };
}

/**
 * 取世界成长规则（按 gameDef.resolvedRules["progression"] 对象身份缓存）。
 * 未配置时返回缺省曲线 + 空技能表。
 */
export function getProgressionRules(world: GameWorld): ProgressionRules {
  const raw = world.gameDef?.resolvedRules?.["progression"];
  if (raw === undefined) {
    return (rulesWithoutConfig ??= { curve: { ...DEFAULT_PROGRESSION_CURVE }, skills: {} });
  }
  const cached = rulesCache.get(raw as object);
  if (cached) return cached;
  const parsed = parseProgressionRules(raw);
  rulesCache.set(raw as object, parsed);
  return parsed;
}

/**
 * 校验单条经验来源配置：
 * - xpValue 缺省 = 不产经验；
 * - 声明 xpValue 须为正有限数；
 * - xpSkill 须非空且已在 skills 表中登记（未知技能属配置笔误）。
 */
function validateXpSource(
  rules: ProgressionRules,
  label: string,
  xpValue: unknown,
  xpSkill: unknown,
): void {
  if (xpValue === undefined && xpSkill === undefined) return;
  if (xpValue !== undefined) {
    if (typeof xpValue !== "number" || !Number.isFinite(xpValue) || xpValue <= 0) {
      progressionFail(`${label}.xpValue must be a positive finite number`);
    }
  }
  if (xpSkill !== undefined) {
    if (typeof xpSkill !== "string" || xpSkill.length === 0) {
      progressionFail(`${label}.xpSkill must be a non-empty string`);
    }
    if (xpValue === undefined) {
      progressionFail(`${label}.xpSkill is declared without xpValue`);
    }
    if (!Object.prototype.hasOwnProperty.call(rules.skills, xpSkill)) {
      progressionFail(
        `${label}.xpSkill "${xpSkill}" is not declared in rules/progression.json skills`,
      );
    }
  }
}

/** 校验原型与资源节点上的经验来源配置（加载期 / 系统构造期共用）。 */
export function validateProgressionAwardConfigs(
  rules: ProgressionRules,
  archetypes: readonly ArchetypeSpec[],
): void {
  for (const arch of archetypes) {
    validateXpSource(rules, `archetype "${arch.kind}"`, arch.xpValue, arch.xpSkill);
    const node = arch.components["ResourceNode"] as
      | { xpValue?: unknown; xpSkill?: unknown }
      | undefined;
    if (node && typeof node === "object") {
      validateXpSource(rules, `archetype "${arch.kind}" ResourceNode`, node.xpValue, node.xpSkill);
    }
  }
}

/**
 * 加载期校验入口（loadGameDefinition.validateIntegrity 调用）：规则 + 全部原型的
 * 经验来源引用一次性 fail-fast。非法配置抛错点名具体原型与字段。
 */
export function validateProgressionConfig(
  rawRules: unknown,
  archetypes: readonly ArchetypeSpec[],
): void {
  const rules = parseProgressionRules(rawRules);
  validateProgressionAwardConfigs(rules, archetypes);
}

/** 系统构造期校验入口：解析当前世界规则并扫描已注册原型。 */
export function validateProgressionRules(world: GameWorld): void {
  validateProgressionAwardConfigs(getProgressionRules(world), world.archetypes.all());
}

/**
 * 由累计经验派生等级（纯函数）。
 *
 * 等级从 1 起：达到 cumulative(L→L+1) 阈值即升级；maxLevel 封顶。
 * xp 为负/非有限值时按 0 处理。
 */
export function levelForXp(xp: number, curve: ProgressionCurve): number {
  const safeXp = Number.isFinite(xp) && xp > 0 ? xp : 0;
  let level = 1;
  let threshold = 0;
  while (level < curve.maxLevel) {
    threshold += Math.max(1, Math.round(curve.baseXp * Math.pow(curve.growth, level - 1)));
    if (safeXp < threshold) break;
    level += 1;
  }
  return level;
}

/** 一次经验结算的结果（供系统 / 测试观察，不参与持久化）。 */
export interface XpGainResult {
  /** 实际入账经验（四舍五入后的正整数）。 */
  amount: number;
  /** 结算后的角色累计经验。 */
  totalXp: number;
  /** 结算前的角色等级。 */
  previousLevel: number;
  /** 结算后的角色等级。 */
  level: number;
  /** 命中的技能结算（未声明 skillId 时缺省）。 */
  skill?: {
    id: string;
    xp: number;
    previousLevel: number;
    level: number;
  };
}

/**
 * 给实体增加经验（通用入口）。
 *
 * @param skillId 可选技能 id。声明时同步累加该技能经验并刷新技能等级；
 *                技能未在 Progression.skills 中时按 0 经验建立（仍不解释语义）。
 * @returns 结算结果；实体无 Progression 或 amount ≤ 0 时返回 undefined。
 */
export function addXp(
  world: GameWorld,
  eid: number,
  amount: number,
  skillId?: string,
): XpGainResult | undefined {
  const state = Progression[eid];
  if (!state) return undefined;
  if (typeof amount !== "number" || !Number.isFinite(amount)) return undefined;
  const gained = Math.round(amount);
  if (gained <= 0) return undefined;

  const rules = getProgressionRules(world);
  const previousLevel = state.level;
  state.totalXp += gained;
  state.level = levelForXp(state.totalXp, rules.curve);

  const result: XpGainResult = {
    amount: gained,
    totalXp: state.totalXp,
    previousLevel,
    level: state.level,
  };

  // CC-04 升级通知（self）：角色等级提升。
  const playerNetworkId = networkIdOf(world, eid);
  if (playerNetworkId !== undefined && state.level > previousLevel) {
    emitClientEvent(
      world,
      "level-up",
      { player: playerNetworkId, level: state.level },
      "self",
      { targetEid: eid },
    );
  }

  if (skillId !== undefined && skillId.length > 0) {
    const skill: SkillProgress =
      state.skills[skillId] ?? (state.skills[skillId] = { xp: 0, level: 1 });
    const previousSkillLevel = skill.level;
    skill.xp += gained;
    skill.level = levelForXp(skill.xp, rules.curve);
    result.skill = {
      id: skillId,
      xp: skill.xp,
      previousLevel: previousSkillLevel,
      level: skill.level,
    };
    // CC-04 升级通知（self）：技能等级提升（与角色等级事件分开，客户端按
    // 是否带 skill 字段区分）。
    if (playerNetworkId !== undefined && skill.level > previousSkillLevel) {
      emitClientEvent(
        world,
        "level-up",
        { player: playerNetworkId, level: skill.level, skill: skillId },
        "self",
        { targetEid: eid },
      );
    }
    if (!Object.prototype.hasOwnProperty.call(rules.skills, skillId)) {
      world.logger.warn("progression skill id has no bonus rule; xp tracked without bonus", {
        eid,
        skillId,
      });
    }
  }

  return result;
}

/** 技能加成汇总：按 stat 名聚合加法与乘法修正。 */
export interface SkillBonuses {
  /** 加法修正：stat → Σ(perLevel × 等级数)。 */
  adds: Record<string, number>;
  /** 乘法修正：stat → Π(1 + perLevel × 等级数)（无条目时消费方按 1 处理）。 */
  muls: Record<string, number>;
}

/**
 * 读取实体的技能属性加成（纯读，无副作用）。
 *
 * 未配置成长规则 / 实体无 Progression / 技能未掌握时返回空加成。
 */
export function getSkillBonuses(world: GameWorld, eid: number): SkillBonuses {
  const out: SkillBonuses = { adds: {}, muls: {} };
  const state = Progression[eid];
  if (!state) return out;
  const rules = getProgressionRules(world);

  for (const [skillId, rule] of Object.entries(rules.skills)) {
    const level = state.skills[skillId]?.level ?? 0;
    const steps = Math.max(0, level - 1);
    if (steps <= 0) continue;
    const amount = rule.perLevel * steps;
    if (amount === 0) continue;
    if (rule.mode === "add") {
      out.adds[rule.stat] = (out.adds[rule.stat] ?? 0) + amount;
    } else {
      out.muls[rule.stat] = (out.muls[rule.stat] ?? 1) * (1 + amount);
    }
  }
  return out;
}

/** 取某属性的技能乘法系数（无加成时 1）。 */
export function getSkillMultiplier(world: GameWorld, eid: number, stat: string): number {
  return getSkillBonuses(world, eid).muls[stat] ?? 1;
}

/** 取某属性的技能加法修正（无加成时 0）。 */
export function getSkillAdd(world: GameWorld, eid: number, stat: string): number {
  return getSkillBonuses(world, eid).adds[stat] ?? 0;
}

/**
 * 采集经验接线：harvest 成功后由 interactionSystem 调用。
 * 读节点 ResourceNode 的 `xpValue` / `xpSkill`；无配置时静默返回。
 */
export function awardHarvestXp(
  world: GameWorld,
  actorEid: number,
  nodeEid: number,
): XpGainResult | undefined {
  const node: ResourceNodeState | undefined = ResourceNode[nodeEid];
  if (!node || node.xpValue === undefined) return undefined;
  return addXp(world, actorEid, node.xpValue, node.xpSkill);
}

/**
 * progressionSystem tick 体：结算本帧击杀经验。
 *
 * **peek 而非 consume** `killed` 帧内事件——questSystem 也消费同一批事件
 * （consumeEvents 为清空式），peek 让两个消费者互不干扰。事件本身在帧首
 * 由 GameInstance.step 清空，不会跨帧重复结算。
 */
export function progressionSystem(world: GameWorld): GameWorld {
  for (const evt of world.runtimeEvents) {
    if (evt.type !== "killed") continue;
    const killer = evt.data.killer;
    const kind = evt.data.kind;
    if (typeof killer !== "number" || typeof kind !== "string" || kind.length === 0) continue;
    if (!world.archetypes.has(kind)) continue;
    const archetype = world.archetypes.get(kind);
    if (archetype.xpValue === undefined) continue;
    addXp(world, killer, archetype.xpValue, archetype.xpSkill);
  }
  return world;
}
