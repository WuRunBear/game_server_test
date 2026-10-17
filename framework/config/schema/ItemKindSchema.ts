import { z } from "zod";

/**
 * item 定义配置 schema（game/items/*.json 数组元素）。
 *
 * item 是纯数据（可堆叠、可被引用），不是实体原型。本文件用 zod 校验 item
 * 目录，声明 consume/equip/place 三类效果（Effect schema）的字段结构与语义，
 * 由 consume/equipment/placeable 系统按 kind 查表解读。
 */

/** 食用/消耗效果：把指定 Need 恢复指定数值。 */
const ConsumeEffectSchema = z.object({
  /** 目标 Need 名（按名匹配实体 Needs 数组中的同名项；具体名由 game/ 配置约定）。 */
  need: z.string(),
  /** 恢复数值。 */
  amount: z.number(),
});

/**
 * 穿戴效果：把物品穿到 Equipment 的指定槽位，并声明加成数值。
 * 各加成字段可选——只声明该物品实际提供的效果。
 */
const EquipEffectSchema = z.object({
  /** 装备槽词（与 Equipment 组件三槽对应）。 */
  slot: z.enum(["weapon", "tool", "armor"]),
  /** 攻击加成（combat 读取修正攻击）。 */
  attackBonus: z.number().optional(),
  /** 防御加成（combat 读取修正防御）。 */
  defenseBonus: z.number().optional(),
  /** 采集产出倍率（gathering 读取修正产出）。 */
  gatherMult: z.number().positive().optional(),
});

/**
 * 效果引用：效果名 + 可选参数（结构对齐 effectRegistry 的 EffectSpec）。
 * item 消费时经 effectRegistry 求值——具体效果语义（加成/状态/定时等）由
 * game/ 配置声明，schema 层只校验通用结构。
 */
const EffectSpecSchema = z.object({
  /** 效果名（effectRegistry 注册名，如 apply-status / set-timer / heal）。 */
  name: z.string(),
  /** 效果参数（透传给执行器；结构由具体效果约定）。 */
  params: z.record(z.string(), z.unknown()).optional(),
});

/** 放置效果：把物品放置成指定 archetype 实体（玩家 place 命令用）。 */
const PlaceEffectSchema = z.object({
  /** 目标实体原型 kind（placeableSystem 经原型注册表查找；其 Placeable 组件配置决定占位尺寸与放置校验）。 */
  archetype: z.string(),
});

/**
 * item kind 定义——item 是数据（由 game/items/*.json 声明），不是实体原型。
 * 字段名与语义保持游戏无关（need/maxStack/amount/slot/archetype 皆为通用机制词）。
 */
export const ItemKindSchema = z.object({
  /** item 种类字符串（全局唯一；被 ResourceNode.yieldsKind / Inventory 槽位引用）。 */
  kind: z.string(),
  /** 单槽最大堆叠数；缺省 1。 */
  maxStack: z.number().int().positive().optional(),
  /** 被 consume 时对持有者 Needs 的恢复效果列表；缺省表示不可食用。 */
  consume: z.array(ConsumeEffectSchema).optional(),
  /**
   * 被 consume（食用/直接使用）时附加施加的效果引用列表（经 effectRegistry
   * 求值，目标 = 使用者）。与 consume 的 Needs 恢复独立——用于状态效果、
   * 定时效果等通用副作用；缺省无附加效果。
   */
  effects: z.array(EffectSpecSchema).optional(),
  /** 穿戴效果（槽位 + 加成）；缺省表示不可穿戴。 */
  equip: EquipEffectSchema.optional(),
  /**
   * 工具分类字符串：通用机制字段，框架不解释其语义，取值由 game/ 配置定义，
   * 仅用于与 ResourceNode.requiredToolType 做相等比对（采集门槛）。
   * 缺省 = 该物品不构成任何工具门槛的满足条件。
   */
  toolType: z.string().optional(),
  /** 可放置声明（目标 archetype）；缺省表示不可放置。 */
  place: PlaceEffectSchema.optional(),
  /**
   * 死亡保留标志：true = 持有者死亡时该物品留在身上（不转入死亡容器）。
   * 缺省 false = 随背包整体转入死亡容器。仅对持有者（玩家）死亡路径生效，
   * 非玩家死亡走 LootTable，与此标志无关。
   */
  keepOnDeath: z.boolean().optional(),
  /**
   * 单件基准价值（正整数）：交易定价的缺省基础——对话买卖效果（buy/sell）
   * 未显式声明 price 时取此值。缺省 = 未定价（该物品不可作为缺省价交易）。
   */
  value: z.number().int().positive().optional(),
  /**
   * 腐烂时长（tick）：物品生成（掉落物/入包）后经过该 tick 数即腐烂。
   * 缺省或 0 = 永不腐烂。绝对到期时刻写入 ItemMeta.spoilAt / ItemStack.spoilAt，
   * 因此读档与离线补差后可继续按真实时间腐烂。
   */
  spoilTicks: z.number().int().nonnegative().optional(),
  /**
   * 腐烂后转换成的 item kind：到期时保留堆叠数量、种类改为该 kind。
   * 缺省 = 直接消失（不留残余）。
   */
  spoilInto: z.string().optional(),
  /**
   * 最大耐久（逐实例状态写 ItemStack.durability）：入包时初始化为该值。
   * 缺省 = 无耐久（历史行为零回归）。加载期要求声明它的物品 maxStack = 1
   * （否则同 kind 堆叠合并无法区分各件剩余耐久）。
   */
  maxDurability: z.number().int().positive().optional(),
  /**
   * 每次「使用」磨损的耐久点数（采集一次 / 攻击命中一次 / 护甲受击一次）。
   * 数值纯配置，缺省 1。仅对声明 maxDurability 的物品有意义——声明了
   * wearPerUse 却没有 maxDurability 属配置缺陷，加载期报错。
   */
  wearPerUse: z.number().int().positive().optional(),
  /**
   * 暴击概率（0~1）：装备在 weapon 槽时，命中按确定性随机流判定暴击。
   * 缺省/0 = 不暴击（历史行为零回归）。字符串/数值均为通用机制词，
   * 具体暴击倍率与伤害类型由配置定义。
   */
  critChance: z.number().min(0).max(1).optional(),
  /**
   * 暴击伤害倍率（≥ 1）：暴击命中时在标准伤害（含防御减免）之上相乘。
   * 声明 critChance 时缺省 1.5；未声明 critChance 时不生效。
   */
  critMultiplier: z.number().min(1).optional(),
  /**
   * 伤害类型字符串（通用机制词，取值由 game/ 配置定义）：攻击方 weapon 槽
   * 物品的 damageType 与防御方 armor 槽物品的 resist 表按键相等匹配。
   * 缺省 = 该武器不参与克制减伤（历史行为零回归）。
   */
  damageType: z.string().optional(),
  /**
   * 伤害类型抗性表（仅 armor 槽生效）：`{ "<damageType>": 0..1 }`。
   * 命中时按攻击方 damageType 取对应抗性，钳制到 [0, 0.9] 后按
   * `伤害 × (1 - 抗性)` 减伤；未列出的类型不减免。
   */
  resist: z.record(z.string(), z.number().min(0).max(1)).optional(),
});

/** 食用/消耗效果的类型推断。 */
export type ConsumeEffect = z.infer<typeof ConsumeEffectSchema>;
/** item 消费附加效果引用的类型推断（结构对齐 effectRegistry.EffectSpec）。 */
export type ItemEffectSpec = z.infer<typeof EffectSpecSchema>;
/** 穿戴效果的类型推断。 */
export type EquipEffect = z.infer<typeof EquipEffectSchema>;
/** 放置效果的类型推断。 */
export type PlaceEffect = z.infer<typeof PlaceEffectSchema>;
/** item kind 定义的类型推断（即 game/items/*.json 数组元素类型）。 */
export type ItemKindSpec = z.infer<typeof ItemKindSchema>;