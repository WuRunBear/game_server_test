/**
 * 实体演化规则 schema（framework/map/evolution/schema.ts）。
 *
 * EntityRule 是补差引擎（engine.ts）的输入数据：一条规则声明「在 map 图的
 * region 区域内，把 kind 实体按 every 周期补足到 max」。按 mode 判别联合：
 * - density：区域内确定性选点补足（见 placement.ts pickPoint）；
 * - exact：固定落点 at（传送门等配对静态项）；
 * - template：成组结构（{kind,dx,dy} 相对偏移，一栋建筑/一段墙），整组原子创建。
 *
 * 纯数据定义：map/region/kind 均为通用标识，含义由 game/ 配置约定，
 * 本模块不含任何游戏语义。
 */
import { z } from "zod";

/** 模板条目：相对模板原点的偏移落点 + 落点处生成的实体 kind。 */
export const TemplateEntrySchema = z.object({
  /** 落点处生成的实体原型 kind。 */
  kind: z.string(),
  /** 相对模板原点的 x 偏移（tile 数）。 */
  dx: z.number().int(),
  /** 相对模板原点的 y 偏移（tile 数）。 */
  dy: z.number().int(),
});

export type TemplateEntry = z.infer<typeof TemplateEntrySchema>;

/** 三种 mode 共有的基础字段。 */
const EntityRuleBaseSchema = z.object({
  /** 规则作用的地图 key（maps registry 键）。 */
  map: z.string(),
  /** 规则作用的区域名（MapGeometry.regions 键）。 */
  region: z.string(),
  /**
   * 计数与补足的实体原型 kind。
   *
   * template 模式下为**锚 kind**：max 按锚 kind 实体数计（约定模板恰含一条
   * kind 与规则 kind 相同的条目，如一扇门标记一座建筑）；引擎按
   * floor((max−count)/锚数) 补足模板实例，模板不含锚 kind 的规则不可满足，
   * 引擎跳过并 warn。
   */
  kind: z.string(),
  /** 数量上限（区域内该 kind 实体数封顶；template 模式下为锚 kind 实体数上限）。 */
  max: z.number().int().min(0),
  /** 补足周期（tick 数）；timeSlot 取 every 的整数倍、绝对对齐（见 engine.ts）。 */
  every: z.number().int().min(1),
  /** 可选门控条件名（spawnConditions 注册表；每 evolve 调用求值一次）。 */
  condition: z.string().optional(),
});

/** density 规则：区域内确定性选点补足。 */
export const DensityRuleSchema = EntityRuleBaseSchema.extend({
  /** 规则模式判别字段。 */
  mode: z.literal("density"),
});

/** exact 规则：固定落点补足（每 timeSlot 至多尝试一次落点）。 */
export const ExactRuleSchema = EntityRuleBaseSchema.extend({
  /** 规则模式判别字段。 */
  mode: z.literal("exact"),
  /** 固定落点（tile 坐标）。 */
  at: z.object({
    /** 落点 x 坐标（tile 数）。 */
    x: z.number().int(),
    /** 落点 y 坐标（tile 数）。 */
    y: z.number().int(),
  }),
});

/** template 规则：成组结构，整组原子创建（任一落点非法则整组放弃）。 */
export const TemplateRuleSchema = EntityRuleBaseSchema.extend({
  /** 规则模式判别字段。 */
  mode: z.literal("template"),
  /** 模板条目（至少一条）；落点 = 模板原点 + (dx, dy)。 */
  template: z.array(TemplateEntrySchema).min(1),
});

/** 实体演化规则（按 mode 判别的联合）。 */
export const EntityRuleSchema = z.discriminatedUnion("mode", [
  DensityRuleSchema,
  ExactRuleSchema,
  TemplateRuleSchema,
]);

export type DensityRule = z.infer<typeof DensityRuleSchema>;
export type ExactRule = z.infer<typeof ExactRuleSchema>;
export type TemplateRule = z.infer<typeof TemplateRuleSchema>;
export type EntityRule = z.infer<typeof EntityRuleSchema>;

// ---------------------------------------------------------------------------
// 文档形态（entity-rules.json 原始形态，templateRef 尚未解析）
// ---------------------------------------------------------------------------

/**
 * 文档形态 template 规则：inline `template` 与命名组 `templateRef` **恰好
 * 声明其一**——双声明/均缺省在 schema 层 fail-fast，错误消息点名违规规则的
 * map/region/kind。
 *
 * 命名组引用由加载器（loadGameDefinition.loadEntityRules）解析为标准
 * inline `template` 形态；引擎与下游只见解析后的 TemplateRuleSchema 形态
 * （演化零改动）。命名组是模板条目的复用单元：同一份条目组（如一栋建筑的
 * 相对布局）可被跨 region/跨图的多条 template 规则引用而不产生复制漂移。
 */
export const TemplateRuleSourceSchema = EntityRuleBaseSchema.extend({
  /** 规则模式判别字段。 */
  mode: z.literal("template"),
  /** inline 模板条目（至少一条）；与 templateRef 恰好声明其一。 */
  template: z.array(TemplateEntrySchema).min(1).optional(),
  /** 命名模板组引用（文档顶层 templates 字典键，非空）；与 template 恰好声明其一。 */
  templateRef: z.string().min(1).optional(),
}).superRefine((rule, ctx) => {
  const hasInline = rule.template !== undefined;
  const hasRef = rule.templateRef !== undefined;
  if (hasInline === hasRef) {
    ctx.addIssue({
      code: "custom",
      message: `template rule on map "${rule.map}" region "${rule.region}" kind "${rule.kind}": declare exactly one of "template" (inline entries) or "templateRef" (named group)`,
    });
  }
});

/** 文档形态规则联合（解析前；density/exact 与标准形态同构，仅 template 分支放宽）。 */
export const EntityRuleSourceSchema = z.discriminatedUnion("mode", [
  DensityRuleSchema,
  ExactRuleSchema,
  TemplateRuleSourceSchema,
]);

/**
 * entity-rules.json 文档 schema：可选的命名模板组字典（组名 → 非空条目数组）
 * + 规则数组。文档不带 templates 段即无命名组（纯 inline 形态，向后兼容）。
 */
export const EntityRulesDocumentSchema = z.object({
  /** 命名模板组字典：组名（非空）→ 模板条目数组（非空）。 */
  templates: z.record(z.string().min(1), z.array(TemplateEntrySchema).min(1)).optional(),
  /** 实体演化规则数组（template 规则可为 templateRef 文档形态）。 */
  rules: z.array(EntityRuleSourceSchema),
});

export type TemplateRuleSource = z.infer<typeof TemplateRuleSourceSchema>;
export type EntityRuleSource = z.infer<typeof EntityRuleSourceSchema>;
export type EntityRulesDocument = z.infer<typeof EntityRulesDocumentSchema>;

/**
 * 规则身份键：选点流派生的 ruleId 输入（见 placement.ts derivePlacementSeed）。
 *
 * 规则无显式 id 字段，身份由内容键（map|region|kind|mode）派生——同身份恒同
 * 候选序列（U4），内容变化即换流。配置不应声明身份键完全相同的两条规则
 * （开机去重校验见 boot.ts assertUniqueRuleIdentity；加载期 templateRef
 * 解析失败的错误消息也引用本键）。
 */
export function ruleIdentity(rule: EntityRule): string {
  return `${rule.map}|${rule.region}|${rule.kind}|${rule.mode}`;
}
