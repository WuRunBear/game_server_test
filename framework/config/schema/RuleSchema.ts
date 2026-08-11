import { z } from "zod";

/**
 * 规则文件配置 schema（game/rules/*.json）。
 *
 * 规则是跨实体的全局配置段（战斗/需求衰减/合成/昼夜/服务端），按文件基名
 * 注册到 ruleSchemas 注册表（见 ruleSchemas.ts），加载时若已注册则用该 schema
 * 校验，未注册则 raw 透传。所有规则 schema 均 .passthrough()——允许额外字段
 * 透传，避免严格校验导致配置演进时破坏兼容。
 */

/**
 * 战斗全局规则：作用于 combat 系统。
 * - friendlyFire：同队是否可互相攻击
 * - damageFormula / damageFormulaRef：伤害公式（内联表达式或注册公式引用）
 * - attackCooldownMs：攻击冷却（毫秒）
 * - attackRange：攻击距离（像素）
 */
export const CombatRuleSchema = z.object({
  friendlyFire: z.boolean().optional(),
  damageFormula: z.string().optional(),
  damageFormulaRef: z.string().optional(),
  attackCooldownMs: z.number().optional(),
  attackRange: z.number().optional(),
}).passthrough();

export type CombatRule = z.infer<typeof CombatRuleSchema>;

/**
 * Needs 全局规则：作用于 needDecaySystem 的衰减倍率。
 *
 * 每个 Need 自身的 decayPerSec/starveDmg 仍在实体 archetype 的 Needs 数组里声明，
 * 规则文件只放跨实体的全局调节项（衰减倍率）。游戏无关。
 */
export const NeedsRuleSchema = z.object({
  decayScale: z.number().optional(),
}).passthrough();

/** Needs 规则的类型推断（即 game/rules/needs.json）。 */
export type NeedsRule = z.infer<typeof NeedsRuleSchema>;

/**
 * 合成配方：inputs 消耗 → outputs 产出。
 *
 * - `stationType`：需要的站点类型编号（缺省 0 = 通用手搓，无需站点）；
 *   非 0 时要求合成者在 stationRange 内有匹配类型的 CraftingStation
 * - `inputs` / `outputs`：kind 字符串引用 item 表 + 数量
 *
 * 字段名保持游戏无关（kind/stationType 皆为通用机制词）。
 */
/** 合成配方输入/输出项：kind 引用 item 表 + 数量。 */
const RecipeInputSchema = z.object({
  kind: z.string(),
  count: z.number().int().positive(),
});

/** 单条合成配方（id 唯一，供客户端/系统引用）。 */
const RecipeSchema = z.object({
  id: z.string(),
  stationType: z.number().int().nonnegative().optional(),
  inputs: z.array(RecipeInputSchema).min(1),
  outputs: z.array(RecipeInputSchema).min(1),
});

export const CraftingRuleSchema = z.object({
  recipes: z.array(RecipeSchema).optional(),
  stationRange: z.number().positive().optional(),
}).passthrough();

export type CraftingRecipe = z.infer<typeof RecipeSchema>;
export type CraftingRule = z.infer<typeof CraftingRuleSchema>;

/**
 * 昼夜循环全局规则：作用于 dayNightCycleSystem。
 *
 * - `cycleLengthSec`：一个昼夜完整周期（小时 0→24）的时长（秒）
 * - `nightStartHour` / `nightEndHour`：夜晚区间（缺省 19 / 5，支持跨午夜）
 *
 * 相位相位编号（PHASE_DAY/PHASE_NIGHT）与小时推进均游戏无关。
 */
export const DayNightRuleSchema = z.object({
  cycleLengthSec: z.number().positive(),
  nightStartHour: z.number().min(0).max(24).optional(),
  nightEndHour: z.number().min(0).max(24).optional(),
}).passthrough();

/** 昼夜规则的类型推断（即 game/rules/daynight.json）。 */
export type DayNightRule = z.infer<typeof DayNightRuleSchema>;

/**
 * 服务端全局规则（rules/server.json）：作用于仿真层的存档/视野/输入校验。
 *
 * 各字段语义游戏无关：
 * - `saveIntervalMs`：定时存档间隔（毫秒）；缺省不自动存档
 * - `saveId`：存档标识（文件实现下为存档文件基名）；缺省不接持久化
 * - `viewRadius`：兴趣管理视野半径（像素）；缺省不裁剪（全量同步，兼容旧协议）
 * - `maxMoveSpeed`：移动输入合成速度上限（像素/秒）；缺省不校验
 * - `maxCommandsPerSec`：命令频率上限（每秒条数，按逻辑 tick 窗口）；缺省不校验
 */
export const ServerRuleSchema = z.object({
  saveIntervalMs: z.number().positive().optional(),
  saveId: z.string().optional(),
  viewRadius: z.number().positive().optional(),
  maxMoveSpeed: z.number().positive().optional(),
  maxCommandsPerSec: z.number().int().positive().optional(),
}).passthrough();

/** 服务端规则的类型推断（即 game/rules/server.json）。 */
export type ServerRule = z.infer<typeof ServerRuleSchema>;
