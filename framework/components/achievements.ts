/**
 * Achievements 组件：实体的成就解锁集合（AoS 结构，按实体索引）。
 *
 * - 世界级解锁事实的唯一权威仍是 `world.progress["achievement:<id>"]`
 *   （achievementSystem 写入、随存档恢复、规则条件经 progressAtLeast 读取）；
 *   本组件是它的**按实体投影**：让 netSync 能经动态 values map 把解锁集合
 *   推给客户端，而不新增 PlayerState 字段（不制造 schema 索引断代）。
 * - 玩家实体在 spawn 时由 AoS 初始化钩子从 world.progress 播种（后加入的
 *   玩家也能看到既有成就）；解锁发生时 achievementSystem 向全部玩家实体写入。
 * - 与 Inventory / Progression 等同为普通 JS 数组（非 bitecs 组件，不能
 *   addComponent/query）；不在 worldSerializer 运行时黑名单中 → 随实体入档。
 *
 * 游戏无关：成就 id / 条件 / 名称全部来自 game/ 配置，框架只保存 id 集合。
 */
import { query } from "bitecs";

import { Player } from "framework/components/tags";
import type { GameWorld } from "framework/world";

/** 成就解锁进度键前缀（world.progress）。 */
export const ACHIEVEMENT_PROGRESS_PREFIX = "achievement:";

/**
 * 待领取奖励进度键前缀（world.progress；F-24）。
 *
 * 成就解锁时若无在线玩家（或没有可归属的触发玩家），玩家侧奖励（物品/势力
 * 声望）无法发放——写入 `achievement-pending:<id> = 1` 挂起，玩家上线后由
 * achievementSystem 补发并删除该键（只发一次；世界侧 progress 奖励在解锁时
 * 已即时结算，不重复）。
 */
export const ACHIEVEMENT_PENDING_PREFIX = "achievement-pending:";

/** 成就进度键（world.progress）。 */
export function achievementProgressKey(id: string): string {
  return `${ACHIEVEMENT_PROGRESS_PREFIX}${id}`;
}

/** 待领取奖励键（world.progress）。 */
export function achievementPendingKey(id: string): string {
  return `${ACHIEVEMENT_PENDING_PREFIX}${id}`;
}

/** 单实体的成就解锁集合：成就 id → 解锁标记（1）。 */
export interface AchievementsState {
  /** 已解锁成就 id 集合（值恒为 1，便于统一投影为数值字段）。 */
  unlocked: Record<string, number>;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const Achievements = [] as (AchievementsState | undefined)[];

/**
 * AoS 初始化钩子：按 world.progress 的既有解锁事实建立实体视图。
 *
 * 新玩家/读档实体都会经过本钩子（读档时 progress 已先恢复）；读档实体随后
 * 由 applyEntityState 用存档的 Achievements 值覆写（存档值胜出）。
 */
export function initAchievements(world: unknown, eid: number): void {
  const progress = (world as { progress?: Record<string, number> } | undefined)?.progress ?? {};
  const unlocked: Record<string, number> = {};
  for (const [key, value] of Object.entries(progress)) {
    if (!key.startsWith(ACHIEVEMENT_PROGRESS_PREFIX)) continue;
    if (typeof value !== "number" || value <= 0) continue;
    unlocked[key.slice(ACHIEVEMENT_PROGRESS_PREFIX.length)] = 1;
  }
  Achievements[eid] = { unlocked };
}

/**
 * 把一次成就解锁同步到全部玩家实体（世界级事实的按实体投影）。
 *
 * 无 Achievements 条目的玩家（未配置本组件的旧原型/测试夹具）跳过——
 * 世界账本仍已写入，语义不受影响。
 */
export function markAchievementUnlocked(world: GameWorld, id: string): void {
  for (const eid of query(world, [Player])) {
    const state = Achievements[eid];
    if (!state) continue;
    state.unlocked[id] = 1;
  }
}
