import { z } from "zod";

/**
 * 玩家规则配置 schema（game/rules/player.json）。
 *
 * 声明玩家出生规则（spawn）——出生点选取模式与限定区域：
 * - mode = "random"：区域内随机选可走点（每玩家独立随机）；
 * - mode = "seededRandom"：由地图内容指纹决定种子的确定性选点；
 * - mode = "exact"：固定落点 at（tile 坐标）。
 * - region：限定出生区域（MapGeometry.regions 键；缺省全图）。
 *
 * 消费方为出生服务（后续 todo 接线）；本 schema 只负责加载期校验。
 */

/** 玩家出生规则：选取模式 + 可选区域限定 + exact 落点。 */
export const PlayerSpawnRuleSchema = z.object({
  /** 选点模式。 */
  mode: z.enum(["random", "seededRandom", "exact"]),
  /** 限定出生区域（MapGeometry.regions 键；缺省全图范围）。 */
  region: z.string().optional(),
  /** exact 模式的固定落点（tile 坐标）。 */
  at: z.object({ x: z.number().int(), y: z.number().int() }).optional(),
});

/** 玩家规则根结构（game/rules/player.json）。 */
export const PlayerRuleSchema = z.object({
  /** 玩家出生规则。 */
  spawn: PlayerSpawnRuleSchema,
}).passthrough();

/** 玩家规则的类型推断（即 game/rules/player.json）。 */
export type PlayerRule = z.infer<typeof PlayerRuleSchema>;
/** 玩家出生规则的类型推断。 */
export type PlayerSpawnRule = z.infer<typeof PlayerSpawnRuleSchema>;
