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