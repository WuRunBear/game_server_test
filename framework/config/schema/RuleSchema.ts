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
 * 战斗全局规则（game/rules/combat.json）：作用于 combat 系统。
 */
export const CombatRuleSchema = z.object({
  /** 同队单位之间是否可互相攻击。 */
  friendlyFire: z.boolean().optional(),
  /** 伤害公式（内联表达式）。 */
  damageFormula: z.string().optional(),
  /** 伤害公式引用（注册公式名）；与内联表达式二选一。 */
  damageFormulaRef: z.string().optional(),
  /** 攻击冷却（毫秒）。 */
  attackCooldownMs: z.number().optional(),
  /** 攻击距离（像素）。 */
  attackRange: z.number().optional(),
}).passthrough();

export type CombatRule = z.infer<typeof CombatRuleSchema>;

/**
 * 放置/拆除/容器取回全局规则（game/rules/place.json）。
 *
 * 三个距离/网格参数都被 placeableSystem / deconstructSystem / inventoryOps
 * 直接消费；缺省值与此前的模块内兜底常量保持一致（64 / 64 / false），
 * 因此旧配置（只写其中一部分字段）行为不变。
 */
export const PlaceRuleSchema = z.object({
  /** 放置/拆除距离（像素）；缺省 64。 */
  placeRange: z.number().nonnegative().default(64),
  /** 容器取回距离（像素，同图同层约束之外的距离上限）；缺省 64。 */
  containerRange: z.number().nonnegative().default(64),
  /** 是否把放置坐标对齐到 tile 格线中心并写入网格占用；缺省 false。 */
  gridSnap: z.boolean().default(false),
}).passthrough();

/** 放置规则的类型推断（即 game/rules/place.json）。 */
export type PlaceRule = z.infer<typeof PlaceRuleSchema>;

/**
 * 成长曲线子规则（progression.curve）：等级 L → L+1 所需经验 =
 * `round(baseXp × growth^(L-1))`。字段均可缺省，缺省值由 progression 模块
 * 的 DEFAULT_PROGRESSION_CURVE 提供（100 / 2 / 99）。
 */
export const ProgressionCurveSchema = z.object({
  /** 1 → 2 级所需经验（正有限数）。 */
  baseXp: z.number().finite().positive().optional(),
  /** 每级阈值增长倍率（有限数 ≥ 1）。 */
  growth: z.number().finite().min(1).optional(),
  /** 等级上限（含，1..10000 的整数）。 */
  maxLevel: z.number().int().min(1).max(10000).optional(),
}).passthrough();

/** 单技能加成子规则：stat 为消费方约定名，框架只透传。 */
export const ProgressionSkillRuleSchema = z.object({
  /** 目标属性名（非空字符串；语义由 game/ 配置约定）。 */
  stat: z.string().min(1),
  /** 每级（高于 1 级的部分）提供的加成量（有限数 ≥ 0）。 */
  perLevel: z.number().finite().nonnegative(),
  /** 加成方式：add = 加到基础值；mul = 乘在基础值上；缺省 add。 */
  mode: z.enum(["add", "mul"]).optional(),
}).passthrough();

/**
 * 成长全局规则（game/rules/progression.json）。
 *
 * 运行时解析（framework/systems/gameplay/progression.ts 的 parseProgressionRules）
 * 直接复用本 schema 做结构校验，再补上曲线/模式缺省值——约束只在本处声明一次，
 * 避免 validate 阶段与系统 fail-fast 漂移。
 */
export const ProgressionRuleSchema = z.object({
  /** 等级曲线；缺省用 DEFAULT_PROGRESSION_CURVE。 */
  curve: ProgressionCurveSchema.optional(),
  /** 技能 id → 属性加成映射；缺省空表。 */
  skills: z.record(z.string().min(1), ProgressionSkillRuleSchema).optional(),
}).passthrough();

/** 成长规则的类型推断（即 game/rules/progression.json；字段可缺省）。 */
export type ProgressionRule = z.infer<typeof ProgressionRuleSchema>;

/**
 * Needs 全局规则：作用于 needDecaySystem 的衰减倍率与环境调制。
 *
 * 每个 Need 自身的 decayPerSec/depletionDmg 仍在实体 archetype 的 Needs 数组里声明，
 * 规则文件只放跨实体的全局调节项（衰减倍率、按 Need 名的环境敏感性）。游戏无关。
 */
export const NeedsRuleSchema = z.object({
  /** 全局需求衰减倍率（乘在实体自身 decayPerSec 之上）。 */
  decayScale: z.number().optional(),
  /**
   * 按 Need 名索引的环境敏感性：`{ "<needName>": { "<modifierKey>": coefficient } }`。
   *
   * modifierKey 对应 WorldClock `environmentAt(world).modifiers` 的键（如温度偏移、
   * 生长速率——框架只当标量，不解释语义）。单 Need 的衰减乘子为
   * `clamp(1 + Σ(coefficient × 当前修饰值), 0.1, 10)`；未列出的 Need 恒为 1。
   */
  environmentFactors: z
    .record(z.string(), z.record(z.string(), z.number()))
    .optional(),
}).passthrough();

/** Needs 规则的类型推断（即 game/rules/needs.json）。 */
export type NeedsRule = z.infer<typeof NeedsRuleSchema>;

/**
 * 供需调制子规则（DialogueTradeRuleSchema.supplyDemand）：近窗口交易量对单价的调制。
 *
 * 交易量记入 `world.progress`：`<prefix>:<kind>` = 有符号成交量（买入为正、卖出为负），
 * `<prefix>:<kind>:lastTick` = 最近一次成交 tick。读取时按绝对 tick 差线性衰减
 * （decayPerTick × 相隔 tick），因此长时间不交易会自然回落到基准价，
 * 不会产生永久漂移。字段游戏无关。
 */
export const DialogueSupplyDemandRuleSchema = z.object({
  /** 每单位有符号成交量对应的价格因子增量（如 0.01：买入 1 件 → 因子 1.01）。 */
  perUnit: z.number(),
  /** 每个 tick 衰减的成交量单位数；缺省 0 = 不衰减（不推荐）。 */
  decayPerTick: z.number().nonnegative().optional(),
  /** 账本键前缀（world.progress 中 `<prefix>:<kind>`）；缺省 "trade"。 */
  volumeKeyPrefix: z.string().min(1).optional(),
}).passthrough();

/**
 * 交易定价子规则（DialogueRuleSchema.trade）：基础价 → 季节/天气 → 供需 → 好感 /
 * 势力声望 的完整调制链。
 *
 * 公式（顺序固定，便于诊断）：
 * ```
 * 基础价       = 显式 price ?? item.value
 * 季节因子     = phaseFactors[当前 phaseId] × weatherFactors[当前 weatherId]（缺省 1）
 * 供需因子     = clamp(1 + perUnit × 衰减后成交量, 0, ∞)
 * 好感因子     = 1 - discountPerRelation × relation（正值打折、负值涨价）
 * 势力因子     = 1 - factionDiscountPerRep × factionRep（同上）
 * 合成因子     = season × supply × relation × faction，再钳到 [minFactor, maxFactor]
 * 实际单价     = max(minPrice, round(基础价 × 合成因子))
 * ```
 * 全部参数游戏无关；相位/天气 id 与势力 id 均为配置字符串。
 */
export const DialogueTradeRuleSchema = z
  .object({
    /** 每点好感对应的折扣率（0..1）；缺省 0 = 不按好感调价。 */
    discountPerRelation: z.number().min(0).max(1).optional(),
    /** 每点势力声望对应的折扣率（0..1）；缺省 0 = 不按声望调价。 */
    factionDiscountPerRep: z.number().min(0).max(1).optional(),
    /** 折后最低单价（≥1）；缺省 1。 */
    minPrice: z.number().int().min(1).optional(),
    /** 合成价格因子的下限；缺省 0（不额外限制）。 */
    minFactor: z.number().nonnegative().optional(),
    /** 合成价格因子的上限（任务要求的 maxFactor）；缺省不设上限。 */
    maxFactor: z.number().positive().optional(),
    /** 按相位 id 的季节价格乘子（缺键 = 1）。 */
    phaseFactors: z.record(z.string(), z.number().nonnegative()).optional(),
    /** 按天气 id 的价格乘子（缺键 = 1；与相位乘子叠乘）。 */
    weatherFactors: z.record(z.string(), z.number().nonnegative()).optional(),
    /** 供需调制配置；缺省 = 不启用供需因子（也不写交易账本）。 */
    supplyDemand: DialogueSupplyDemandRuleSchema.optional(),
  })
  .passthrough()
  .superRefine((rule, ctx) => {
    if (rule.minFactor !== undefined && rule.maxFactor !== undefined && rule.minFactor > rule.maxFactor) {
      ctx.addIssue({
        code: "custom",
        message: `trade.minFactor (${rule.minFactor}) must be <= trade.maxFactor (${rule.maxFactor})`,
        path: ["minFactor"],
      });
    }
  });

/**
 * 对话全局规则（game/rules/dialogue.json）：作用于 dialogueSystem。
 * 字段语义游戏无关（范围/通用交易定价调制）。
 */
export const DialogueRuleSchema = z.object({
  /** 对话交互距离（像素）；缺省 48。 */
  talkRange: z.number().positive().optional(),
  /** 交易定价的好感折扣配置；缺省不调价。 */
  trade: DialogueTradeRuleSchema.optional(),
}).passthrough();

/** 交易折扣规则的类型推断。 */
export type DialogueTradeRule = z.infer<typeof DialogueTradeRuleSchema>;
/** 供需子规则的类型推断。 */
export type DialogueSupplyDemandRule = z.infer<typeof DialogueSupplyDemandRuleSchema>;
/** 对话规则的类型推断（即 game/rules/dialogue.json）。 */
export type DialogueRule = z.infer<typeof DialogueRuleSchema>;

/**
 * 单个势力定义（game/rules/factions.json 的 factions[] 元素）。
 *
 * 势力是通用社交分组：`members` 列出属于该势力的 NPC kind（配置字符串），
 * 交易/任务提交时按 NPC kind 反查势力并把声望记到玩家身上。
 */
export const FactionDefinitionSchema = z.object({
  /** 势力 id（配置字符串；任务/成就/规则引用键）。 */
  id: z.string().min(1),
  /** 显示名（可选；框架只透传）。 */
  name: z.string().optional(),
  /** 玩家初始声望；缺省 0。 */
  initialRep: z.number().optional(),
  /** 属于该势力的 NPC kind 列表（archetype kind 字符串）。 */
  members: z.array(z.string()).optional(),
  /** 每成交一件商品获得的势力声望；缺省 0 = 交易不改变声望。 */
  repPerTradeUnit: z.number().optional(),
}).passthrough();

/**
 * 势力规则（game/rules/factions.json）：势力定义 + 成员映射。
 * 声望账本载体复用 Relation（玩家 AoS 持久组件，键为 `faction:<id>`）。
 */
export const FactionRuleSchema = z
  .object({
    /** 势力定义列表。 */
    factions: z.array(FactionDefinitionSchema),
  })
  .passthrough()
  .superRefine((rule, ctx) => {
    const seen = new Set<string>();
    rule.factions.forEach((faction, index) => {
      if (seen.has(faction.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate faction id "${faction.id}"`,
          path: ["factions", index, "id"],
        });
      }
      seen.add(faction.id);
    });
  });

/** 单个势力定义的类型推断。 */
export type FactionDefinition = z.infer<typeof FactionDefinitionSchema>;
/** 势力规则的类型推断（即 game/rules/factions.json）。 */
export type FactionRule = z.infer<typeof FactionRuleSchema>;

/** 成就奖励（可选）：物品、世界进度增量、势力声望增量。 */
export const AchievementRewardSchema = z.object({
  /** 奖励物品（授予触发解锁的玩家；无玩家时跳过）。 */
  items: z
    .array(
      z.object({
        /** 物品 kind（item 目录引用）。 */
        kind: z.string().min(1),
        /** 数量。 */
        count: z.number().int().positive(),
      }),
    )
    .optional(),
  /** 世界进度增量（写入 world.progress，全服共享）。 */
  progress: z.record(z.string(), z.number()).optional(),
  /** 势力声望增量（授予触发解锁的玩家；无玩家时跳过）。 */
  factionRep: z
    .array(
      z.object({
        /** 势力 id（factions 规则引用）。 */
        factionId: z.string().min(1),
        /** 声望增量。 */
        delta: z.number(),
      }),
    )
    .optional(),
}).passthrough();

/**
 * 单个成就定义（game/rules/achievements.json 的 achievements[] 元素）。
 *
 * 条件复用 spawnConditions 注册表（支持 `progressAtLeast` / `factionRepAtLeast`
 * 等带参条件）；满足后写入 `world.progress["achievement:<id>"] = 1`（幂等，
 * 只发一次 on-achievement 事件）。
 */
export const AchievementDefinitionSchema = z.object({
  /** 成就 id（配置字符串；进度键后缀）。 */
  id: z.string().min(1),
  /** 显示名（可选）。 */
  name: z.string().optional(),
  /** 描述（可选）。 */
  description: z.string().optional(),
  /** 解锁条件名（spawnConditions 注册表引用，支持带参 `基名:参数`）。 */
  condition: z.string().min(1),
  /** 可选奖励。 */
  reward: AchievementRewardSchema.optional(),
}).passthrough();

/** 成就规则（game/rules/achievements.json）。 */
export const AchievementRuleSchema = z
  .object({
    /** 成就定义列表。 */
    achievements: z.array(AchievementDefinitionSchema),
  })
  .passthrough()
  .superRefine((rule, ctx) => {
    const seen = new Set<string>();
    rule.achievements.forEach((achievement, index) => {
      if (seen.has(achievement.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate achievement id "${achievement.id}"`,
          path: ["achievements", index, "id"],
        });
      }
      seen.add(achievement.id);
    });
  });

/** 单个成就定义的类型推断。 */
export type AchievementDefinition = z.infer<typeof AchievementDefinitionSchema>;
/** 成就奖励的类型推断。 */
export type AchievementReward = z.infer<typeof AchievementRewardSchema>;
/** 成就规则的类型推断（即 game/rules/achievements.json）。 */
export type AchievementRule = z.infer<typeof AchievementRuleSchema>;

/** 合成配方输入/输出项：kind 引用 item 表 + 数量。 */
const RecipeInputSchema = z.object({
  /** 引用的 item kind（item 定义表中的 kind 字符串）。 */
  kind: z.string(),
  /** 数量。 */
  count: z.number().int().positive(),
});

/** 单条合成配方：inputs 消耗 → outputs 产出。 */
const RecipeSchema = z.object({
  /** 配方 id（唯一，供客户端/系统引用）。 */
  id: z.string(),
  /** 需要的站点类型编号；0/缺省表示通用手搓（无需站点），非 0 时要求合成者在 stationRange 内有匹配类型的站点。 */
  stationType: z.number().int().nonnegative().optional(),
  /** 消耗的输入项列表。 */
  inputs: z.array(RecipeInputSchema).min(1),
  /** 产出的输出项列表。 */
  outputs: z.array(RecipeInputSchema).min(1),
});

/**
 * 合成全局规则（game/rules/crafting.json）：作用于 crafting 系统。
 * 字段名保持游戏无关（kind/stationType 皆为通用机制词）。
 */
export const CraftingRuleSchema = z.object({
  /** 合成配方列表。 */
  recipes: z.array(RecipeSchema).optional(),
  /** 合成站点交互距离（像素）。 */
  stationRange: z.number().positive().optional(),
}).passthrough();

export type CraftingRecipe = z.infer<typeof RecipeSchema>;
export type CraftingRule = z.infer<typeof CraftingRuleSchema>;

/**
 * 昼夜循环全局规则（game/rules/daynight.json）：作用于 dayNightCycleSystem。
 * 相位编号（PHASE_DAY/PHASE_NIGHT）与小时推进均游戏无关。
 */
export const DayNightRuleSchema = z.object({
  /** 一个昼夜完整周期（小时 0→24）的时长（秒）。 */
  cycleLengthSec: z.number().positive(),
  /** 夜晚区间起始小时（支持跨午夜）。 */
  nightStartHour: z.number().min(0).max(24).optional(),
  /** 夜晚区间结束小时（支持跨午夜）。 */
  nightEndHour: z.number().min(0).max(24).optional(),
}).passthrough();

/** 昼夜规则的类型推断（即 game/rules/daynight.json）。 */
export type DayNightRule = z.infer<typeof DayNightRuleSchema>;

/**
 * 相位修饰数值：常量，或随相位进度在 `[from, to]` 间线性插值。
 * 字段名由 game/ 配置自定（框架只当标量求值），例：temperatureOffset / growthScale。
 */
export const EnvironmentModifierSchema = z.union([
  z.number(),
  z.object({
    /** 相位起点处的值。 */
    from: z.number(),
    /** 相位终点处（进度→1）的值。 */
    to: z.number(),
  }),
]);

/** 相位内的天气候选与权重。 */
export const PhaseWeatherOptionSchema = z.object({
  /** 天气 id（配置字符串；框架只当不透明标识）。 */
  id: z.string(),
  /** 抽样权重（正数；同相位内按权重比例抽样）。 */
  weight: z.number().positive(),
});

/**
 * 派生地面覆盖规则：把底板语义在当前相位下映射为「有效语义」（如积雪/湿地）。
 *
 * 只描述**派生视图**（服务端权威、查询期求值），不写回 MapGeometry：
 * 底板 tiles 恒定不变，有效语义由 (相位, 相位进度, 层号, 区域, 格坐标 hash)
 * 纯函数派生。匹配顺序 = 数组顺序，后一条规则以前一条的输出为输入（可链式）。
 */
export const GroundOverrideSchema = z.object({
  /** 生效相位 id（必须已在 phases 中声明）。 */
  phaseId: z.string().min(1),
  /** 底板（或前序规则输出）语义 id。 */
  fromSemantic: z.number().int().min(0).max(255),
  /** 派生后的有效语义 id。 */
  toSemantic: z.number().int().min(0).max(255),
  /** 层号下界（含；缺省不限）。用于「雪线随海拔」类规则。 */
  minLevel: z.number().int().optional(),
  /** 层号上界（含；缺省不限）。 */
  maxLevel: z.number().int().optional(),
  /** 相位进度下界 [0,1]（含；缺省 0）。用于随进度推进/消融的窗口。 */
  minProgress: z.number().min(0).max(1).optional(),
  /** 相位进度上界 [0,1]（含；缺省 1）。 */
  maxProgress: z.number().min(0).max(1).optional(),
  /**
   * 覆盖率 [0,1]（常量或随进度线性 `{ from, to }`）：格坐标 hash 落在阈值内
   * 才应用本条（斑驳覆盖）。缺省 1 = 全格覆盖。相位 id + 坐标参与 hash，
   * 因此同一年同一批格子先/后变化，且不会逐 tick 闪烁。
   */
  coverage: z
    .union([
      z.number().min(0).max(1),
      z.object({ from: z.number().min(0).max(1), to: z.number().min(0).max(1) }),
    ])
    .optional(),
  /** 仅在这些区域生效（缺省不限）。空白数组等价于不限制。 */
  regions: z.array(z.string()).optional(),
  /** 在这些区域内不生效（优先级高于 regions）。 */
  excludeRegions: z.array(z.string()).optional(),
});

/**
 * 单个相位：id + 时长（tick）+ 天气候选 + 通用修饰数值。
 */
export const EnvironmentPhaseSchema = z.object({
  /** 相位 id（game/ 提供的配置字符串；框架只当不透明标识）。 */
  id: z.string(),
  /** 相位时长（tick）；相位程序内各时长之和为一周期，按绝对槽对齐循环。 */
  durationTicks: z.number().int().positive(),
  /** 该相位允许的天气候选（可省略＝该相位恒定无天气）。 */
  weather: z.array(PhaseWeatherOptionSchema).optional(),
  /**
   * 该相位的通用修饰数值（键自定，如 temperatureOffset/growthScale）；
   * 值为常量或 `{ from, to }`（按进度线性）。框架只当标量，不解释语义。
   */
  modifiers: z.record(z.string(), EnvironmentModifierSchema).optional(),
});

/**
 * 环境/相位时钟全局规则（game/rules/environment.json）：作用于 environmentSystem。
 *
 * 相位与天气皆为 tick 的纯函数（见 framework/simulation/worldClock）——本规则
 * 只描述相位程序与天气抽样参数，不含任何运行时累积状态；字段语义游戏无关
 * （相位/天气 id 均来自配置字符串）。
 */
export const EnvironmentRuleSchema = z
  .object({
    /** 天气抽样种子（世界级）；缺省 0。同 seed + 同天气槽恒同天气。 */
    seed: z.number().int().optional(),
    /** 天气槽长度（tick）；槽索引 = floor(tick / weatherSlotTicks)。 */
    weatherSlotTicks: z.number().int().positive(),
    /** 相位程序（按数组顺序循环；一周期 = 各相位时长之和）。 */
    phases: z.array(EnvironmentPhaseSchema).min(1),
    /**
     * 派生地面覆盖（查询期派生，不写回底板）：按相位把某些地面语义映射为
     * 另一种「有效语义」，支持层号/相位进度/区域/坐标 hash 斑驳条件。
     * 缺省 = 无派生（effectiveGround 恒等于底板语义）。
     */
    groundOverrides: z.array(GroundOverrideSchema).optional(),
  })
  .passthrough()
  .superRefine((rule, ctx) => {
    const seen = new Set<string>();
    rule.phases.forEach((phase, index) => {
      if (seen.has(phase.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate phase id "${phase.id}"`,
          path: ["phases", index, "id"],
        });
      }
      seen.add(phase.id);
    });

    (rule.groundOverrides ?? []).forEach((override, index) => {
      if (!seen.has(override.phaseId)) {
        ctx.addIssue({
          code: "custom",
          message: `groundOverrides[${index}] references unknown phase id "${override.phaseId}"`,
          path: ["groundOverrides", index, "phaseId"],
        });
      }
      if (
        override.minLevel !== undefined &&
        override.maxLevel !== undefined &&
        override.minLevel > override.maxLevel
      ) {
        ctx.addIssue({
          code: "custom",
          message: `groundOverrides[${index}] minLevel (${override.minLevel}) > maxLevel (${override.maxLevel})`,
          path: ["groundOverrides", index, "minLevel"],
        });
      }
      if (
        override.minProgress !== undefined &&
        override.maxProgress !== undefined &&
        override.minProgress > override.maxProgress
      ) {
        ctx.addIssue({
          code: "custom",
          message: `groundOverrides[${index}] minProgress (${override.minProgress}) > maxProgress (${override.maxProgress})`,
          path: ["groundOverrides", index, "minProgress"],
        });
      }
    });
  });

/** 相位修饰数值类型推断（即 environment.json 的 modifiers 值）。 */
export type EnvironmentModifier = z.infer<typeof EnvironmentModifierSchema>;
/** 派生地面覆盖规则类型推断。 */
export type GroundOverride = z.infer<typeof GroundOverrideSchema>;
/** 相位天气候选类型推断。 */
export type PhaseWeatherOption = z.infer<typeof PhaseWeatherOptionSchema>;
/** 单相位类型推断。 */
export type EnvironmentPhase = z.infer<typeof EnvironmentPhaseSchema>;
/** 环境/相位时钟规则的类型推断（即 game/rules/environment.json）。 */
export type EnvironmentRule = z.infer<typeof EnvironmentRuleSchema>;

/**
 * 服务端全局规则（game/rules/server.json）：作用于仿真层的存档/视野/输入校验。
 * 各字段语义游戏无关。
 */
export const ServerRuleSchema = z.object({
  /** 定时存档间隔（毫秒）；缺省不自动存档。 */
  saveIntervalMs: z.number().positive().optional(),
  /** 存档标识（文件实现下为存档文件基名）；缺省不接持久化。 */
  saveId: z.string().optional(),
  /** 兴趣管理视野半径（像素）；缺省不裁剪（同图全量同步）。 */
  viewRadius: z.number().positive().optional(),
  /** 移动输入合成速度上限（像素/秒）；缺省不校验。 */
  maxMoveSpeed: z.number().positive().optional(),
  /** 命令频率上限（每秒条数，按逻辑 tick 窗口）；缺省不校验。 */
  maxCommandsPerSec: z.number().int().positive().optional(),
  /**
   * 断线保留时长（tick）：会话断开后玩家实体保留的 tick 数，保留期内实体
   * 对同步与玩法系统不可见，到期销毁并触发一次立即存档。
   * 缺省 5 分钟（按 tickRate 折算，见 GameSimulation.DEFAULT_OFFLINE_RETENTION_SEC）；
   * 0 = 维持旧行为（断线立即销毁实体）。
   */
  offlineRetentionTicks: z.number().int().nonnegative().optional(),
}).passthrough();

/** 服务端规则的类型推断（即 game/rules/server.json）。 */
export type ServerRule = z.infer<typeof ServerRuleSchema>;

/**
 * 周期袭击全局规则（game/rules/raid.json）：作用于 raidSystem（袭击导演）。
 * 各字段语义游戏无关（"袭击"是通用机制词——谁袭击谁、什么物种由 game/ 配置）。
 */
export const RaidRuleSchema = z.object({
  /** 门控周期（tick，绝对对齐槽 world.time.tick % intervalTicks === 0）。 */
  intervalTicks: z.number().int().min(1),
  /** 缺省波成员数（waveRef 接管波构建时忽略）。 */
  waveSize: z.number().int().min(0),
  /** 缺省波成员的原型 kind 池（每成员确定性挑一）。 */
  kinds: z.array(z.string()).min(1),
  /** 落位搜索半径（tile）。 */
  radiusTiles: z.number().int().positive().optional(),
  /** 整波刷怪条件名（spawnConditions 注册表引用，如 isNight）；未知名求值时抛错。 */
  condition: z.string().optional(),
  /**
   * 导演门槛条件名（spawnConditions 注册表引用，支持带参 `基名:参数`）：
   * 门控槽求值不满足则**跳过该轮**（不进预警、不刷波）——语义定位是"进度/门槛"
   * 门控（Valheim 事件门槛），与环境窗口门控 condition 互为补充；未知名求值时抛错。
   */
  requireCondition: z.string().optional(),
  /**
   * 预警期时长（tick）：> 0 时门控命中先进预警窗口（每 tick 对在线玩家发
   * on-raid-warning 事件），倒计时结束才刷波；0/缺省 = 即刷（旧行为）。
   * 无在线玩家时倒计时冻结（进度保留，不推进不重置）。
   */
  warnTicks: z.number().int().min(0).optional(),
  /**
   * 结构防御对抗开关：true 时发波同时为波成员指派玩家基地附近的建造物目标
   * （最近的有 Health 的 Structure 实体，搜索半径 structureRadiusTiles），
   * 成员在射程内持续攻击之（打坏由 deathSystem 统一销毁）；缺省 false。
   */
  attackStructures: z.boolean().optional(),
  /** 结构目标搜索半径（tile，围绕玩家；缺省 = radiusTiles）。 */
  structureRadiusTiles: z.number().int().positive().optional(),
  /** 可选规则模块引用（registerRuleModule 扩展点）：模块 (world, playerEid, ctx) 返回波成员描述并完全接管缺省波构建器；未知名求值时抛错。 */
  waveRef: z.string().optional(),
}).passthrough();

/** 周期袭击规则的类型推断（即 game/rules/raid.json）。 */
export type RaidRule = z.infer<typeof RaidRuleSchema>;

/**
 * 野火子规则（DisasterRuleSchema.wildfire）：灾害天气下点燃可燃格与可燃实体。
 * 字段语义通用（wildfire/scorch/ignite 是灾害机制词）；具体语义 id 由 game/ 配置约定。
 */
export const WildfireRuleSchema = z.object({
  /** 可燃地面语义 id 集合（点燃候选格的地面语义须在其中）。 */
  flammableGrounds: z.array(z.number().int().min(0).max(255)).min(1),
  /** 焦土地面语义 id（空可燃格起火立即写回；可燃实体烧尽由其状态机效果写回）。 */
  scorchGround: z.number().int().min(0).max(255),
  /** 每个在线玩家每次触发的点燃尝试数（确定性 rng 候选点；缺省 4）。 */
  attempts: z.number().int().min(1).optional(),
  /** 点燃搜索半径（tile，围绕在线玩家；缺省 6）。 */
  radiusTiles: z.number().int().positive().optional(),
  /** 可燃实体 kind 集合（点燃点命中即点燃/损毁；缺省不点燃实体、只烧地面）。 */
  flammableKinds: z.array(z.string()).optional(),
  /** 点燃可燃实体时发出的状态机信号名（缺省 "ignite"；原型自配对应 on 迁移）。 */
  igniteSignal: z.string().optional(),
}).passthrough();

/** 野火子规则的类型推断。 */
export type WildfireRule = z.infer<typeof WildfireRuleSchema>;

/**
 * 风暴子规则（DisasterRuleSchema.storm）：灾害天气下露天实体周期伤害。
 */
export const StormRuleSchema = z.object({
  /** 伤害触发周期（tick，绝对对齐槽；缺省 = 灾害 intervalTicks）。 */
  damageIntervalTicks: z.number().int().min(1).optional(),
  /** 每次对露天实体造成的伤害量（直扣 Health；自然灾害不走防御减免）。 */
  damage: z.number().positive(),
}).passthrough();

/** 风暴子规则的类型推断。 */
export type StormRule = z.infer<typeof StormRuleSchema>;

/**
 * 天气灾害全局规则（game/rules/disasters.json）：作用于 disasterSystem。
 *
 * 当 environmentAt(world).weatherId === weatherId 时进入灾害窗口，按
 * intervalTicks 对齐槽周期触发配置的灾害效果（野火/风暴）。灾害触发点用
 * 确定性 rng 纯派生（同 seed 同 tick 恒同结果）；离线补差不重放 tick 系统，
 * 灾害自然不参与补差（与写回入口切片同口径）。
 */
export const DisasterRuleSchema = z.object({
  /** 触发灾害窗口的天气 id（environment 规则的天气候选 id 字符串）。 */
  weatherId: z.string().min(1),
  /** 灾害效果触发周期（tick，绝对对齐槽；缺省 600）。 */
  intervalTicks: z.number().int().min(1).optional(),
  /** 野火子规则；缺省不触发野火。 */
  wildfire: WildfireRuleSchema.optional(),
  /** 风暴子规则；缺省不触发风暴伤害。 */
  storm: StormRuleSchema.optional(),
}).passthrough();

/** 天气灾害规则的类型推断（即 game/rules/disasters.json）。 */
export type DisasterRule = z.infer<typeof DisasterRuleSchema>;

/**
 * 死亡容器配置（respawn 规则的 deathContainer 段）。
 *
 * 玩家死亡时的通用惩罚机制：在死亡位置生成一个可取回的容器实体，
 * 把背包整体转入（keepOnDeath 物品除外）；容器限期后销毁、内容物随之消失。
 */
const DeathContainerSchema = z.object({
  /** 容器实体原型 kind（archetype 注册表引用；未注册原型时记 error 并跳过生成）。 */
  archetype: z.string().min(1),
  /**
   * 容器存活时限（tick 数）；到期销毁（内容物一并消失）。
   * 缺省 6000（≈5 分钟 @20tps）；0 = 永不过期。
   */
  ttlTicks: z.number().int().nonnegative().optional(),
});

/**
 * 重生全局规则（game/rules/respawn.json）：作用于 respawnSystem（重生延迟/Needs
 * 重置）与 deathSystem（死亡容器）。各字段语义游戏无关。
 */
export const RespawnRuleSchema = z.object({
  /** 重生延迟（毫秒）。 */
  delayMs: z.number().optional(),
  /** 重生时是否重置 Needs；缺省 true。 */
  resetNeeds: z.boolean().optional(),
  /** 死亡容器配置；缺省 = 玩家死亡不生成容器（维持无惩罚旧行为）。 */
  deathContainer: DeathContainerSchema.optional(),
}).passthrough();

/** 重生规则的类型推断（即 game/rules/respawn.json）。 */
export type RespawnRule = z.infer<typeof RespawnRuleSchema>;
