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
 * Needs 全局规则：作用于 needDecaySystem 的衰减倍率。
 *
 * 每个 Need 自身的 decayPerSec/depletionDmg 仍在实体 archetype 的 Needs 数组里声明，
 * 规则文件只放跨实体的全局调节项（衰减倍率）。游戏无关。
 */
export const NeedsRuleSchema = z.object({
  /** 全局需求衰减倍率（乘在实体自身 decayPerSec 之上）。 */
  decayScale: z.number().optional(),
}).passthrough();

/** Needs 规则的类型推断（即 game/rules/needs.json）。 */
export type NeedsRule = z.infer<typeof NeedsRuleSchema>;

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

/** 单个相位：id + 时长（tick）+ 天气候选 + 通用修饰数值。 */
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
  });

/** 相位修饰数值类型推断（即 environment.json 的 modifiers 值）。 */
export type EnvironmentModifier = z.infer<typeof EnvironmentModifierSchema>;
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
 * 周期袭击全局规则（game/rules/raid.json）：作用于 raidSystem。
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
  /** 可选规则模块引用（registerRuleModule 扩展点）：模块 (world, playerEid, ctx) 返回波成员描述并完全接管缺省波构建器；未知名求值时抛错。 */
  waveRef: z.string().optional(),
}).passthrough();

/** 周期袭击规则的类型推断（即 game/rules/raid.json）。 */
export type RaidRule = z.infer<typeof RaidRuleSchema>;

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
