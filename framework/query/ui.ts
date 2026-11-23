/**
 * UI 只读投影（`/query/quests|achievements|skills`）。
 *
 * 静态定义复用 `/content` 的 `buildContentCatalog`（labels/条件结构化/奖励
 * 投影的唯一来源），运行时进度只读玩家 AoS 组件（Quest/Achievements/
 * Progression）与世界进度账本；不复制 quest/achievement/progression 的判定。
 */
import { Achievements, Progression, Quest } from "components";
import { buildContentCatalog, QUEST_STATE_NONE, type ContentAchievement } from "framework/content/catalog";
import { isAchievementUnlocked } from "framework/systems/gameplay/achievementSystem";
import { getProgressionRules } from "framework/systems/gameplay/progression";
import type { GameWorld } from "world";
import { findPlayerEid, queryFail, queryOk, type QueryResult } from "./types";

/** 任务条目（静态定义 + 玩家运行时进度）。 */
export interface QuestEntry {
  id: string;
  title: string;
  description: string;
  type: "collect" | "kill";
  goal: { count: number; itemKind?: string; victimKind?: string };
  rewards: { items: Array<{ kind: string; count: number }>; relationDelta: number };
  /** 0 未接 / 1 进行中 / 2 可提交 / 3 已完成（与 Quest 组件一致）。 */
  state: number;
  count: number;
  /** 是否已在玩家任务列表中（state ≠ 0）。 */
  accepted: boolean;
}

export interface QuestsResponse {
  quests: QuestEntry[];
}

/** 成就条目（静态定义 + 世界/玩家解锁事实）。 */
export interface AchievementEntry {
  id: string;
  name: string;
  description: string;
  condition: string;
  conditionSpec?: ContentAchievement["conditionSpec"];
  reward: unknown;
  unlocked: boolean;
}

export interface AchievementsResponse {
  achievements: AchievementEntry[];
}

/** 技能运行时条目。 */
export interface SkillEntry {
  id: string;
  label: string;
  stat: string;
  perLevel: number;
  mode: "add" | "mul";
  maxLevel: number;
  xp: number;
  level: number;
  /** 玩家 Progression 中是否已有该技能条目（初始技能/已获得经验）。 */
  learned: boolean;
}

export interface SkillsResponse {
  curve: { baseXp: number; growth: number; maxLevel: number };
  /** 玩家角色累计经验/等级（Progression 组件；无组件时为 0/1）。 */
  totalXp: number;
  level: number;
  skills: SkillEntry[];
}

/** 查询玩家的任务定义 + 进度（全部 catalog 任务；未接的 state=0）。 */
export function queryQuests(
  world: GameWorld,
  playerNetworkId: number,
): QueryResult<QuestsResponse> {
  const playerEid = findPlayerEid(world, playerNetworkId);
  if (playerEid === undefined) return queryFail("player_not_found");

  const catalog = buildContentCatalog(world.gameDef);
  const runtime = new Map((Quest[playerEid] ?? []).map((entry) => [entry.questId, entry]));

  const quests: QuestEntry[] = catalog.quests.map((quest) => {
    const progress = runtime.get(quest.id);
    return {
      id: quest.id,
      title: quest.title,
      description: quest.desc,
      type: quest.type,
      goal: quest.goal,
      rewards: quest.rewards,
      state: progress?.state ?? QUEST_STATE_NONE,
      count: progress?.count ?? 0,
      accepted: progress !== undefined,
    };
  });

  return queryOk({ quests });
}

/** 查询成就定义 + 解锁事实（玩家投影优先，世界账本兜底）。 */
export function queryAchievements(
  world: GameWorld,
  playerNetworkId: number,
): QueryResult<AchievementsResponse> {
  const playerEid = findPlayerEid(world, playerNetworkId);
  if (playerEid === undefined) return queryFail("player_not_found");

  const catalog = buildContentCatalog(world.gameDef);
  const playerUnlocked = Achievements[playerEid]?.unlocked ?? {};

  const achievements: AchievementEntry[] = catalog.achievements.map((achievement) => ({
    id: achievement.id,
    name: achievement.title,
    description: achievement.desc,
    condition: achievement.condition,
    ...(achievement.conditionSpec !== undefined
      ? { conditionSpec: achievement.conditionSpec }
      : {}),
    reward: achievement.reward ?? null,
    unlocked:
      playerUnlocked[achievement.id] === 1 || isAchievementUnlocked(world, achievement.id),
  }));

  return queryOk({ achievements });
}

/** 查询技能曲线 + 玩家技能进度（静态映射来自 catalog，进度来自 Progression）。 */
export function querySkills(
  world: GameWorld,
  playerNetworkId: number,
): QueryResult<SkillsResponse> {
  const playerEid = findPlayerEid(world, playerNetworkId);
  if (playerEid === undefined) return queryFail("player_not_found");

  const catalog = buildContentCatalog(world.gameDef);
  const rules = getProgressionRules(world);
  const state = Progression[playerEid];

  const skills: SkillEntry[] = catalog.skills.map((skill) => {
    const progress = state?.skills[skill.id];
    return {
      id: skill.id,
      label: skill.label,
      stat: skill.stat,
      perLevel: skill.perLevel,
      mode: skill.mode,
      maxLevel: skill.maxLevel,
      xp: progress?.xp ?? 0,
      level: progress?.level ?? 0,
      learned: progress !== undefined,
    };
  });

  return queryOk({
    curve: { ...rules.curve },
    totalXp: state?.totalXp ?? 0,
    level: state?.level ?? 1,
    skills,
  });
}
