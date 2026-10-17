/**
 * Progression 组件：实体的经验 / 等级 / 技能进度（AoS 结构）。
 *
 * - `totalXp` 是角色累计经验；`level` 是由 `totalXp` 经等级曲线派生的角色等级。
 * - `skills` 是任意 `skillId → { xp, level }` 表。skillId 与技能效果映射
 *   完全由 game/ 配置定义（rules/progression.json + 原型 / 资源节点声明），
 *   框架只保存与推进数值，不解释任何技能语义。
 * - 与 Inventory / Needs 等同为 AoS（普通 JS 数组按 eid 索引）：不是 bitecs
 *   组件，不能 addComponent/query；由 spawn 的 AoS 初始化钩子写入。
 * - 不在 worldSerializer 的运行时黑名单中 → 随实体自动入档（读档后技能/经验
 *   继续，无需额外持久化代码）。
 */

/** 单个技能的进度：累计经验与派生等级。 */
export interface SkillProgress {
  /** 该技能累计经验。 */
  xp: number;
  /** 该技能等级（1 起；由技能经验经曲线派生）。 */
  level: number;
}

/** 单实体的成长状态。 */
export interface ProgressionState {
  /** 角色累计经验（所有来源之和）。 */
  totalXp: number;
  /** 角色等级（由 totalXp 经曲线派生）。 */
  level: number;
  /** 技能进度表：skillId → 进度。 */
  skills: Record<string, SkillProgress>;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const Progression = [] as (ProgressionState | undefined)[];

/** Progression archetype 配置形态：初始技能 id 列表（可选）。 */
interface ProgressionConfig {
  /**
   * 初始技能 id 列表。每个技能以 `{ xp: 0, level: 1 }` 建立——技能等级 1
   * 视为「已掌握」，加成规则通常按 `level - 1` 计算。
   */
  skills?: string[];
}

/** AoS 初始化钩子：按 archetype 配置建立成长状态。 */
export function initProgression(_world: unknown, eid: number, config: unknown): void {
  const cfg = (config ?? {}) as ProgressionConfig;
  const skills: Record<string, SkillProgress> = {};
  if (Array.isArray(cfg.skills)) {
    for (const skillId of cfg.skills) {
      if (typeof skillId !== "string" || skillId.length === 0) continue;
      skills[skillId] = { xp: 0, level: 1 };
    }
  }
  Progression[eid] = { totalXp: 0, level: 1, skills };
}
