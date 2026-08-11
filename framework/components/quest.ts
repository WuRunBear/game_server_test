/**
 * Quest 组件：玩家任务状态（AoS 结构，挂玩家实体，持久入档）。
 *
 * 每项为一条任务进度：questId 引用 game/quests/*.json 的任务定义，
 * state 为状态机（0=available 未接 / 1=active 进行 / 2=ready 可交 /
 * 3=done 完成），count 为击杀型任务的累计计数（收集型任务读背包，count 恒 0）。
 *
 * 由 questSystem 写入/推进（acceptQuest / 进度检查 / submitQuest）；
 * 持久组件：随玩家实体自动序列化入档，恢复后进度保留。
 */
export interface QuestState {
  /** 任务定义 id（game/quests/*.json 的 quests[].id）。 */
  questId: string;
  /** 状态机（0=未接 / 1=进行 / 2=可交 / 3=完成）。 */
  state: number;
  /** 击杀型任务的累计计数（收集型恒 0）。 */
  count: number;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const Quest = [] as (QuestState[] | undefined)[];

// 任务状态常量（与 QuestState.state 字段对应）
/** 0=未接（可接取）。 */
export const QUEST_AVAILABLE = 0;
/** 1=进行中。 */
export const QUEST_ACTIVE = 1;
/** 2=满足条件，可提交。 */
export const QUEST_READY = 2;
/** 3=已完成。 */
export const QUEST_DONE = 3;
