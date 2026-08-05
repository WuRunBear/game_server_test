import type { ZodType } from "zod";
import {
  CombatRuleSchema,
  NeedsRuleSchema,
  CraftingRuleSchema,
  DayNightRuleSchema,
  ServerRuleSchema,
} from "framework/config/schema/RuleSchema";

/**
 * 通用规则 schema 注册表。
 *
 * 规则文件（game/rules/*.json）按文件名（去 .json）入 `resolvedRules`。
 * 历史上 loadRulesFile 完全 raw 加载，schema 层是装饰性（从无人 parse）。
 * 现改为：若该文件名已注册 schema，则用该 schema parse 并校验；
 * 未注册则保持 raw 透传（向后兼容，不强制每个规则都有 schema）。
 *
 * 注册名保持游戏无关——用规则文件基名作为 key（combat / needs 等）。
 */
const ruleSchemas = new Map<string, ZodType>();

export function registerRuleSchema(name: string, schema: ZodType): void {
  ruleSchemas.set(name, schema);
}

export function getRuleSchema(name: string): ZodType | undefined {
  return ruleSchemas.get(name);
}

export function hasRuleSchema(name: string): boolean {
  return ruleSchemas.has(name);
}

/** 注册内建规则 schema。由 bootstrapFramework 调用。 */
export function registerBuiltinRuleSchemas(): void {
  registerRuleSchema("combat", CombatRuleSchema);
  registerRuleSchema("needs", NeedsRuleSchema);
  registerRuleSchema("crafting", CraftingRuleSchema);
  registerRuleSchema("daynight", DayNightRuleSchema);
  registerRuleSchema("server", ServerRuleSchema);
}