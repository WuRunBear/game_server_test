import { z } from "zod";

/**
 * 食用/消耗效果：把指定 Need 恢复指定数值。
 *
 * `need` 是字符串引用 Need 名（具体名由 game/ 配置约定）；框架不识别具体语义，
 * 仅按名匹配实体的 Needs 数组中同名的 Need 项。游戏无关。
 */
const ConsumeEffectSchema = z.object({
  need: z.string(),
  amount: z.number(),
});

/**
 * item kind 定义——item 是数据（由 game/items/*.json 声明），不是实体原型。
 *
 * - `kind`：item 种类字符串（全局唯一），被 ResourceNode.yieldsKind / Inventory 槽位引用
 * - `maxStack`：单槽最大堆叠数，缺省 1
 * - `consume`：被 consume 时对持有者 Needs 的恢复效果列表；缺省表示不可食用
 *
 * 字段名与语义保持游戏无关（need/maxStack/amount 皆为通用机制词）。
 */
export const ItemKindSchema = z.object({
  kind: z.string(),
  maxStack: z.number().int().positive().optional(),
  consume: z.array(ConsumeEffectSchema).optional(),
});

export type ConsumeEffect = z.infer<typeof ConsumeEffectSchema>;
export type ItemKindSpec = z.infer<typeof ItemKindSchema>;