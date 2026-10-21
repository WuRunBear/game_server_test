/**
 * 内容目录（framework/content/catalog.ts）——`/content` 端点的数据源。
 *
 * 目的：让客户端**不再硬编码静态表**（物品名/配方/任务/成就/相位/技能），
 * 一次 HTTP 拉取即拿到当前 game/ 配置的全量内容清单。
 *
 * 内容来源（全部取自当前配置，框架不解释语义、只做搬运与形态归一）：
 * - `items` ← game/items/*.json（物品定义）
 * - `recipes` ← game/rules/crafting.json（合成配方）
 * - `quests` ← game/quests/*.json（任务定义）
 * - `achievements` ← game/rules/achievements.json（成就定义）
 * - `phases` ← game/rules/environment.json（相位定义）
 * - `skills` ← game/rules/progression.json（技能定义）
 *
 * 名称/描述的取值链（见 labels.ts）：配置自带字段 → 游戏层注册的展示名 →
 * 配置 id/kind 原文。框架内**不含任何游戏名词**（中文兜底名由游戏层注册）。
 */
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";
import type { QuestDefinitionJson } from "framework/config/schema/QuestSchema";
import type {
  AchievementRule,
  CraftingRule,
  EnvironmentRule,
  ProgressionRule,
} from "framework/config/schema/RuleSchema";
import { resolveContentLabel, itemLabelOf } from "./labels";

/** 物品条目（未配置的字段省略）。 */
export interface ContentItem {
  /** 物品 kind（全局唯一标识）。 */
  kind: string;
  /** 展示名（配置自带 → 游戏层注册 → kind 原文）。 */
  label: string;
  /** 单槽最大堆叠数。 */
  maxStack?: number;
  /** 最大耐久。 */
  maxDurability?: number;
  /** 工具分类（与资源点的工具门槛比对）。 */
  toolType?: string;
  /** 食用效果（恢复的生存需求）。 */
  consume?: ItemKindSpec["consume"];
  /** 穿戴效果（槽位 + 加成）。 */
  equip?: ItemKindSpec["equip"];
  /** 放置效果（目标实体原型）。 */
  place?: ItemKindSpec["place"];
  /** 腐烂时长（tick）。 */
  spoilTicks?: number;
  /** 基准价值（交易定价缺省基础）。 */
  value?: number;
  /** 投掷档案。 */
  throw?: ItemKindSpec["throw"];
}

/** 合成配方条目。 */
export interface ContentRecipe {
  /** 配方 id。 */
  id: string;
  /** 消耗材料（[kind, 数量] 列表）。 */
  inputs: Array<[string, number]>;
  /** 产出物品（[kind, 数量] 列表）。 */
  outputs: Array<[string, number]>;
  /** 站点类型要求（缺省 = 无站点要求）。 */
  stationType?: number;
  /** 延时制作时长（tick；缺省 = 瞬时完成）。 */
  durationTicks?: number;
  /** 解锁条件声明。 */
  unlock?: { condition?: string; [key: string]: unknown };
  /** 配方描述（配置未声明时用展示名兜底）。 */
  desc?: string;
}

/** 任务条目。 */
export interface ContentQuest {
  /** 任务 id。 */
  id: string;
  /** 任务状态（0 未接 / 1 进行中 / 2 可提交 / 3 已完成）。 */
  state: number;
  /** 任务进度计数。 */
  count: number;
  /** 任务标题（配置未声明时用展示名兜底）。 */
  title: string;
  /** 任务描述（配置未声明时按目标形态生成可读兜底文案）。 */
  desc: string;
}

/** 成就条目。 */
export interface ContentAchievement {
  /** 成就 id。 */
  id: string;
  /** 成就标题（配置 name 字段；缺省用展示名兜底）。 */
  title: string;
  /** 成就描述（配置 description 字段；缺省用条件兜底）。 */
  desc: string;
  /** 解锁条件（服务端裁决的表达式）。 */
  condition: string;
  /** 奖励声明。 */
  reward?: unknown;
}

/** 相位条目（环境规则的相位定义）。 */
export interface ContentPhase {
  /** 相位 id。 */
  id: string;
  /** 相位时长（tick）。 */
  durationTicks: number;
  /** 该相位的天气候选（id + 权重）。 */
  weather: Array<{ id: string; weight: number }>;
  /** 相位修饰值（常量或 {from,to} 线性插值声明，原样透传）。 */
  modifiers?: Record<string, unknown>;
}

/** 技能条目。 */
export interface ContentSkill {
  /** 技能 id。 */
  id: string;
  /** 技能展示名（游戏层注册的中文名优先）。 */
  label: string;
}

/** 内容目录全量（`/content` 响应体）。 */
export interface ContentCatalog {
  /** 物品清单。 */
  items: ContentItem[];
  /** 合成配方清单。 */
  recipes: ContentRecipe[];
  /** 任务清单。 */
  quests: ContentQuest[];
  /** 成就清单。 */
  achievements: ContentAchievement[];
  /** 环境相位清单。 */
  phases: ContentPhase[];
  /** 技能清单。 */
  skills: ContentSkill[];
}

/** 任务状态枚举（与 questSystem 的状态编号一致）。 */
export const QUEST_STATE_NONE = 0;

/** 只在定义存在时拷出的字段（避免响应体出现 undefined 键）。 */
function pick<T extends object, K extends keyof T>(source: T, key: K): T[K] | undefined {
  const value = source[key];
  return value === undefined ? undefined : value;
}

/** 物品条目：按物品定义逐字段搬运（未配置的字段省略）。 */
function toContentItem(spec: ItemKindSpec): ContentItem {
  // 展示名取链：配置自带 → 游戏层注册（src/register.ts）→ kind 原文。
  const item: ContentItem = { kind: spec.kind, label: resolveContentLabel("item", spec.kind) };
  const maxStack = pick(spec, "maxStack");
  if (maxStack !== undefined) item.maxStack = maxStack;
  const maxDurability = pick(spec, "maxDurability");
  if (maxDurability !== undefined) item.maxDurability = maxDurability;
  const toolType = pick(spec, "toolType");
  if (toolType !== undefined) item.toolType = toolType;
  const consume = pick(spec, "consume");
  if (consume !== undefined) item.consume = consume;
  const equip = pick(spec, "equip");
  if (equip !== undefined) item.equip = equip;
  const place = pick(spec, "place");
  if (place !== undefined) item.place = place;
  const spoilTicks = pick(spec, "spoilTicks");
  if (spoilTicks !== undefined) item.spoilTicks = spoilTicks;
  const value = pick(spec, "value");
  if (value !== undefined) item.value = value;
  const throwProfile = pick(spec, "throw");
  if (throwProfile !== undefined) item.throw = throwProfile;
  return item;
}

/** 配方条目：材料/产出归一为 [kind, 数量] 列表。 */
function toContentRecipe(recipe: NonNullable<CraftingRule["recipes"]>[number]): ContentRecipe {
  const entry: ContentRecipe = {
    id: recipe.id,
    inputs: recipe.inputs.map((input) => [input.kind, input.count] as [string, number]),
    outputs: recipe.outputs.map((output) => [output.kind, output.count] as [string, number]),
  };
  const stationType = pick(recipe, "stationType");
  if (stationType !== undefined) entry.stationType = stationType;
  const durationTicks = (recipe as { durationTicks?: number }).durationTicks;
  if (durationTicks !== undefined) entry.durationTicks = durationTicks;
  const unlock = (recipe as { unlock?: { condition?: string } }).unlock;
  if (unlock !== undefined) entry.unlock = unlock;
  const desc = (recipe as { desc?: string }).desc;
  entry.desc = desc ?? resolveContentLabel("recipe", recipe.id);
  return entry;
}

/** 任务描述兜底：按目标形态生成可读文案（目标物品/实体用其展示名）。 */
function questDescription(quest: QuestDefinitionJson): string {
  if (quest.type === "collect") {
    const target = quest.itemKind ? itemLabelOf(quest.itemKind) : "";
    return `收集 ${quest.goal} 个${target}`;
  }
  const target = quest.victimKind ? resolveContentLabel("entity", quest.victimKind) : "";
  return `击败 ${quest.goal} 个${target}`;
}

/** 任务条目：状态/计数为中性缺省（具体进度以玩家实体同步为准）。 */
function toContentQuest(quest: QuestDefinitionJson): ContentQuest {
  return {
    id: quest.id,
    state: QUEST_STATE_NONE,
    count: 0,
    title: resolveContentLabel("quest", quest.id),
    desc: questDescription(quest),
  };
}

/** 成就条目：标题/描述取配置字段，缺省走展示名/条件兜底。 */
function toContentAchievement(achievement: NonNullable<AchievementRule["achievements"]>[number]): ContentAchievement {
  const entry: ContentAchievement = {
    id: achievement.id,
    title: achievement.name ?? resolveContentLabel("achievement", achievement.id),
    desc: achievement.description ?? `达成条件：${achievement.condition}`,
    condition: achievement.condition,
  };
  const reward = pick(achievement, "reward");
  if (reward !== undefined) entry.reward = reward;
  return entry;
}

/** 相位条目：时长/天气候选/修饰值。 */
function toContentPhase(phase: EnvironmentRule["phases"][number]): ContentPhase {
  const entry: ContentPhase = {
    id: phase.id,
    durationTicks: phase.durationTicks,
    weather: (phase.weather ?? []).map((option) => ({ id: option.id, weight: option.weight })),
  };
  const modifiers = pick(phase, "modifiers");
  if (modifiers !== undefined) entry.modifiers = modifiers as Record<string, unknown>;
  return entry;
}

/**
 * 构建内容目录（`/content` 响应体）。
 *
 * @param gameDef 已加载的游戏配置
 * @returns 内容目录（各段为空数组表示对应配置未声明）
 */
export function buildContentCatalog(gameDef: LoadedGameDefinition): ContentCatalog {
  const crafting = gameDef.resolvedRules["crafting"] as CraftingRule | undefined;
  const achievements = gameDef.resolvedRules["achievements"] as AchievementRule | undefined;
  const environment = gameDef.resolvedRules["environment"] as EnvironmentRule | undefined;
  const progression = gameDef.resolvedRules["progression"] as ProgressionRule | undefined;

  return {
    items: gameDef.resolvedItems.map(toContentItem),
    recipes: (crafting?.recipes ?? []).map(toContentRecipe),
    quests: gameDef.resolvedQuests.map(toContentQuest),
    achievements: (achievements?.achievements ?? []).map(toContentAchievement),
    phases: (environment?.phases ?? []).map(toContentPhase),
    skills: Object.entries(progression?.skills ?? {}).map(([id]) => ({
      id,
      label: resolveContentLabel("skill", id),
    })),
  };
}
