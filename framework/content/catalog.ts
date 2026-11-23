/**
 * 内容目录（framework/content/catalog.ts）——`/content` 端点的数据源。
 *
 * 目的：让客户端**不再硬编码静态表**（物品名/配方/任务/成就/相位/技能/势力/
 * 站点/伤害类型），一次 HTTP 拉取即拿到当前 game/ 配置的全量内容清单。
 *
 * ## 机制 vs 展示文本的边界
 *
 * - **机制字段**：本文件只把配置里**已经存在**的数值/枚举/结构原样搬运或做
 *   最小形态归一（如 inputs 归一为 `[kind, count]`），不解释玩法语义、不推导
 *   规则。框架内**不含任何游戏名词**——具体物品/势力/伤害类型名由 game/ 配置
 *   或游戏层注册的展示名提供。
 * - **展示文本**：取值链为「配置自带 name/description → labels 注册表 →
 *   配置 id/kind 原文」（见 labels.ts）。缺名时回退 id，绝不编造中文名。
 *
 * ## `/content` 是静态模板，不是运行时状态
 *
 * 本响应描述“这个世界**有哪些内容**”，不描述“某个玩家现在怎么样”：
 * - 任务条目的 `state/count` 是模板缺省值（0/0）；运行时进度看玩家实体同步的
 *   `Quest.{i}.questId/state/count`（见 game.json 的 netSync），或后续
 *   `/query/quests` 端点。
 * - 成就的 `unlocked` 是模板缺省值（false）；运行时解锁状态看玩家实体的
 *   `Achievements.{id}`。
 * - 商店的**实价/库存**由交易定价链与 Ledger 在运行时决定，不在本响应；需要时
 *   走 `/query/shop`（或读 NPC 的 Ledger 同步）。
 * - 物品的当前耐久/腐烂剩余、合成任务剩余 tick 等逐实例状态同样看实体同步。
 *
 * 内容来源（全部取自当前配置）：
 * - `items` ← game/items/*.json（物品定义）
 * - `recipes` ← game/rules/crafting.json（合成配方；durationTicks/unlock 由
 *   craftingSystem 解析，本文件按原始声明投影，durationTicks 缺省 0）
 * - `quests` ← game/quests/*.json（任务定义）
 * - `achievements` ← game/rules/achievements.json（成就定义）
 * - `phases` ← game/rules/environment.json（相位定义）
 * - `skills` ← game/rules/progression.json（技能定义 + 等级曲线）
 * - `factions` ← game/rules/factions.json（势力定义）
 * - `stationTypes` ← recipes.stationType ∪ 实体 CraftingStation.stationType
 * - `damageTypes` ← items/实体配置中出现的 damageType 与 resist 键
 */
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";
import type { QuestDefinitionJson } from "framework/config/schema/QuestSchema";
import type {
  AchievementRule,
  CraftingRule,
  EnvironmentRule,
  FactionRule,
  ProgressionRule,
} from "framework/config/schema/RuleSchema";
import { DEFAULT_PROGRESSION_CURVE } from "framework/systems/gameplay/progression";
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
  /** 每次使用磨损的耐久点数。 */
  wearPerUse?: number;
  /** 工具分类（与资源点的工具门槛比对）。 */
  toolType?: string;
  /** 食用效果（恢复的生存需求）。 */
  consume?: ItemKindSpec["consume"];
  /** 消耗/使用时经 effectRegistry 求值的附加效果（原始结构）。 */
  effects?: ItemKindSpec["effects"];
  /** 穿戴效果（槽位 + 加成）。 */
  equip?: ItemKindSpec["equip"];
  /** 放置效果（目标实体原型）。 */
  place?: ItemKindSpec["place"];
  /** 腐烂时长（tick）。 */
  spoilTicks?: number;
  /** 腐烂后转换成的 item kind。 */
  spoilInto?: string;
  /** 死亡时是否保留在持有者身上（不转入死亡容器）。 */
  keepOnDeath?: boolean;
  /** 暴击概率（0~1，仅 weapon 槽生效）。 */
  critChance?: number;
  /** 暴击伤害倍率（≥ 1）。 */
  critMultiplier?: number;
  /** 攻击伤害类型（与护甲 resist 键匹配）。 */
  damageType?: string;
  /** 伤害类型抗性表（仅 armor 槽生效）。 */
  resist?: ItemKindSpec["resist"];
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
  /** 站点类型要求（缺省 = 无站点要求；0 与缺省同义）。 */
  stationType?: number;
  /** 延时制作时长（tick；缺省 0 = 瞬时完成）。 */
  durationTicks: number;
  /** 解锁条件声明（原始结构，如 `{ condition: "inPhase:storm" }`）。 */
  unlock?: { condition?: string; [key: string]: unknown };
  /** 配方描述（配置未声明时用展示名兜底）。 */
  desc?: string;
}

/** 任务目标（静态定义；state/count 见条目本体）。 */
export interface ContentQuestGoal {
  /** collect 型：目标物品 kind。 */
  itemKind?: string;
  /** kill 型：目标实体 kind。 */
  victimKind?: string;
  /** 目标数量。 */
  count: number;
}

/** 任务提交奖励（原始字段；当前 schema 无 xp 字段，不编造）。 */
export interface ContentQuestRewards {
  /** 奖励物品列表。 */
  items: Array<{ kind: string; count: number }>;
  /** 提交后对提交对话 NPC 所属势力的好感增减。 */
  relationDelta: number;
}

/** 任务条目。 */
export interface ContentQuest {
  /** 任务 id。 */
  id: string;
  /** 任务状态模板值（0 未接 / 1 进行中 / 2 可提交 / 3 已完成；运行时看玩家 Quest）。 */
  state: number;
  /** 任务进度计数模板值（0；运行时看玩家 Quest）。 */
  count: number;
  /** 任务标题（配置未声明时用展示名兜底）。 */
  title: string;
  /** 任务描述（配置未声明时按目标形态生成可读兜底文案）。 */
  desc: string;
  /** 目标形态：collect（收集）/ kill（击杀）。 */
  type: QuestDefinitionJson["type"];
  /** 静态目标定义（itemKind/victimKind/count）。 */
  goal: ContentQuestGoal;
  /** 提交奖励（物品 + 好感；当前 schema 无经验奖励字段）。 */
  rewards: ContentQuestRewards;
}

/** 结构化条件：按 `:` 切分条件名与参数（参数保持原始字符串，不解释语义）。 */
export interface ContentConditionSpec {
  /** 条件基名（spawnConditions 注册名）。 */
  kind: string;
  /** 冒号后的原始参数段（可能为空数组）。 */
  args: string[];
}

/** 成就条目。 */
export interface ContentAchievement {
  /** 成就 id。 */
  id: string;
  /** 成就标题（配置 name 字段；缺省用展示名兜底）。 */
  title: string;
  /** 成就描述（配置 description 字段；缺省用条件兜底）。 */
  desc: string;
  /** 解锁条件原文（服务端裁决的表达式）。 */
  condition: string;
  /** 条件的只读结构化投影（简单 `:` 切分，不复制 spawnConditions 求值逻辑）。 */
  conditionSpec?: ContentConditionSpec;
  /** 解锁状态模板值（false；运行时看玩家实体 Achievements.{id}）。 */
  unlocked: boolean;
  /** 奖励声明（原始结构）。 */
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

/** 等级曲线（与 progression 系统的运行时有效值一致：缺省补框架缺省曲线）。 */
export interface ContentProgressionCurve {
  /** 1 → 2 级所需经验。 */
  baseXp: number;
  /** 每级阈值增长倍率。 */
  growth: number;
  /** 等级上限（含）。 */
  maxLevel: number;
}

/** 技能条目。 */
export interface ContentSkill {
  /** 技能 id。 */
  id: string;
  /** 技能展示名（游戏层注册的中文名优先）。 */
  label: string;
  /** 目标属性名（消费方约定，如 attack/gatherMult）。 */
  stat: string;
  /** 每级（高于 1 级的部分）提供的加成量。 */
  perLevel: number;
  /** 加成方式：add = 加到基础值；mul = 乘在基础值上。 */
  mode: "add" | "mul";
  /** 等级上限（来自当前成长曲线）。 */
  maxLevel: number;
  /** 等级曲线（与运行时有效值一致）。 */
  curve: ContentProgressionCurve;
}

/** 势力条目。 */
export interface ContentFaction {
  /** 势力 id。 */
  id: string;
  /** 展示名（配置 name → 游戏层注册 → id）。 */
  name: string;
  /** 玩家初始声望。 */
  initialRep: number;
  /** 属于该势力的 NPC kind 列表。 */
  members: string[];
  /** 每成交一件商品获得的势力声望（配置声明时输出）。 */
  repPerTradeUnit?: number;
}

/** 合成站点类型条目（只列配置中实际出现的类型）。 */
export interface ContentStationType {
  /** 站点类型编号（与 recipe.stationType / CraftingStation.stationType 匹配）。 */
  id: number;
  /** 展示名（游戏层注册 → 编号原文）。 */
  label: string;
}

/** 伤害类型条目（从配置中实际出现的键收集，不编造中文名）。 */
export interface ContentDamageType {
  /** 伤害类型 id（与 item.damageType / item.resist 键匹配）。 */
  id: string;
  /** 展示名（游戏层注册 → id 原文；未注册时即 id）。 */
  label: string;
}

/** 内容目录全量（`/content` 响应体）。 */
export interface ContentCatalog {
  /** 物品清单。 */
  items: ContentItem[];
  /** 合成配方清单。 */
  recipes: ContentRecipe[];
  /** 任务清单（静态定义 + 模板 state/count）。 */
  quests: ContentQuest[];
  /** 成就清单（静态定义 + 模板 unlocked）。 */
  achievements: ContentAchievement[];
  /** 环境相位清单。 */
  phases: ContentPhase[];
  /** 技能清单（含加成映射与等级曲线）。 */
  skills: ContentSkill[];
  /** 势力清单。 */
  factions: ContentFaction[];
  /** 合成站点类型清单（配置中实际出现的类型）。 */
  stationTypes: ContentStationType[];
  /** 伤害类型清单（配置中实际出现的类型）。 */
  damageTypes: ContentDamageType[];
}

/** 任务状态枚举（与 questSystem 的状态编号一致）。 */
export const QUEST_STATE_NONE = 0;

/** 只在定义存在时拷出的字段（避免响应体出现 undefined 键）。 */
function pick<T extends object, K extends keyof T>(source: T, key: K): T[K] | undefined {
  const value = source[key];
  return value === undefined ? undefined : value;
}

/** 普通对象判定（排除 null / 数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 物品条目：按物品定义逐字段搬运（未配置的字段省略）。 */
function toContentItem(spec: ItemKindSpec): ContentItem {
  // 展示名取链：配置自带 → 游戏层注册（src/register.ts）→ kind 原文。
  const item: ContentItem = { kind: spec.kind, label: resolveContentLabel("item", spec.kind) };
  const maxStack = pick(spec, "maxStack");
  if (maxStack !== undefined) item.maxStack = maxStack;
  const maxDurability = pick(spec, "maxDurability");
  if (maxDurability !== undefined) item.maxDurability = maxDurability;
  const wearPerUse = pick(spec, "wearPerUse");
  if (wearPerUse !== undefined) item.wearPerUse = wearPerUse;
  const toolType = pick(spec, "toolType");
  if (toolType !== undefined) item.toolType = toolType;
  const consume = pick(spec, "consume");
  if (consume !== undefined) item.consume = consume;
  const effects = pick(spec, "effects");
  if (effects !== undefined) item.effects = effects;
  const equip = pick(spec, "equip");
  if (equip !== undefined) item.equip = equip;
  const place = pick(spec, "place");
  if (place !== undefined) item.place = place;
  const spoilTicks = pick(spec, "spoilTicks");
  if (spoilTicks !== undefined) item.spoilTicks = spoilTicks;
  const spoilInto = pick(spec, "spoilInto");
  if (spoilInto !== undefined) item.spoilInto = spoilInto;
  const keepOnDeath = pick(spec, "keepOnDeath");
  if (keepOnDeath !== undefined) item.keepOnDeath = keepOnDeath;
  const critChance = pick(spec, "critChance");
  if (critChance !== undefined) item.critChance = critChance;
  const critMultiplier = pick(spec, "critMultiplier");
  if (critMultiplier !== undefined) item.critMultiplier = critMultiplier;
  const damageType = pick(spec, "damageType");
  if (damageType !== undefined) item.damageType = damageType;
  const resist = pick(spec, "resist");
  if (resist !== undefined) item.resist = resist;
  const value = pick(spec, "value");
  if (value !== undefined) item.value = value;
  const throwProfile = pick(spec, "throw");
  if (throwProfile !== undefined) item.throw = throwProfile;
  return item;
}

/**
 * 配方条目：材料/产出归一为 [kind, 数量] 列表。
 *
 * `durationTicks`/`unlock` 不是 RecipeSchema 的声明字段，但 craftingSystem 会
 * 从规则原始内容解析（见 framework/systems/gameplay/craftingSystem.ts 的
 * parseRecipeExtension）；loadGameDefinition 用 mergeUnknownKeys 保留了这些
 * 透传字段，故这里按原始声明投影。durationTicks 缺省语义 = 0（瞬时）。
 */
function toContentRecipe(recipe: NonNullable<CraftingRule["recipes"]>[number]): ContentRecipe {
  const raw = recipe as NonNullable<CraftingRule["recipes"]>[number] & {
    durationTicks?: number;
    unlock?: { condition?: string; [key: string]: unknown };
    desc?: string;
  };
  const entry: ContentRecipe = {
    id: recipe.id,
    inputs: recipe.inputs.map((input) => [input.kind, input.count] as [string, number]),
    outputs: recipe.outputs.map((output) => [output.kind, output.count] as [string, number]),
    durationTicks: raw.durationTicks ?? 0,
  };
  const stationType = pick(recipe, "stationType");
  if (stationType !== undefined) entry.stationType = stationType;
  if (raw.unlock !== undefined) entry.unlock = raw.unlock;
  entry.desc = raw.desc ?? resolveContentLabel("recipe", recipe.id);
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

/**
 * 任务条目：静态定义 + 模板状态/计数。
 *
 * `state/count` 固定为中性缺省（0/0）——具体进度以玩家实体同步的
 * `Quest.{i}.questId/state/count` 为准；不要把模板值当成某个玩家的实时进度。
 */
function toContentQuest(quest: QuestDefinitionJson): ContentQuest {
  const goal: ContentQuestGoal = { count: quest.goal };
  if (quest.itemKind !== undefined) goal.itemKind = quest.itemKind;
  if (quest.victimKind !== undefined) goal.victimKind = quest.victimKind;

  return {
    id: quest.id,
    state: QUEST_STATE_NONE,
    count: 0,
    title: resolveContentLabel("quest", quest.id),
    desc: questDescription(quest),
    type: quest.type,
    goal,
    rewards: {
      items: quest.submit.rewards.map((reward) => ({ kind: reward.kind, count: reward.count })),
      relationDelta: quest.submit.relationDelta,
    },
  };
}

/** 简单只读条件解析：`基名:参数...` → `{ kind, args }`（不解释参数类型）。 */
function parseConditionSpec(condition: string): ContentConditionSpec | undefined {
  const [rawKind, ...args] = condition.split(":");
  const kind = rawKind?.trim();
  if (!kind) return undefined;
  return { kind, args };
}

/** 成就条目：标题/描述取配置字段，缺省走展示名/条件兜底。 */
function toContentAchievement(achievement: NonNullable<AchievementRule["achievements"]>[number]): ContentAchievement {
  const entry: ContentAchievement = {
    id: achievement.id,
    title: achievement.name ?? resolveContentLabel("achievement", achievement.id),
    desc: achievement.description ?? `达成条件：${achievement.condition}`,
    condition: achievement.condition,
    unlocked: false,
  };
  const conditionSpec = parseConditionSpec(achievement.condition);
  if (conditionSpec) entry.conditionSpec = conditionSpec;
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

/** 有效等级曲线：配置声明优先，缺省补 progression 系统同一份缺省值。 */
function resolveProgressionCurve(progression: ProgressionRule | undefined): ContentProgressionCurve {
  const curve = progression?.curve;
  return {
    baseXp: curve?.baseXp ?? DEFAULT_PROGRESSION_CURVE.baseXp,
    growth: curve?.growth ?? DEFAULT_PROGRESSION_CURVE.growth,
    maxLevel: curve?.maxLevel ?? DEFAULT_PROGRESSION_CURVE.maxLevel,
  };
}

/** 技能条目：加成映射（mode 缺省 add，与 progression 解析一致）+ 曲线。 */
function toContentSkill(
  id: string,
  definition: NonNullable<ProgressionRule["skills"]>[string],
  curve: ContentProgressionCurve,
): ContentSkill {
  return {
    id,
    label: resolveContentLabel("skill", id),
    stat: definition.stat,
    perLevel: definition.perLevel,
    mode: definition.mode ?? "add",
    maxLevel: curve.maxLevel,
    curve: { ...curve },
  };
}

/** 势力条目：名称走「配置 name → 注册名 → id」链。 */
function toContentFaction(faction: NonNullable<FactionRule["factions"]>[number]): ContentFaction {
  const entry: ContentFaction = {
    id: faction.id,
    name: faction.name ?? resolveContentLabel("faction", faction.id),
    initialRep: faction.initialRep ?? 0,
    members: [...(faction.members ?? [])],
  };
  const repPerTradeUnit = pick(faction, "repPerTradeUnit");
  if (repPerTradeUnit !== undefined) entry.repPerTradeUnit = repPerTradeUnit;
  return entry;
}

/** 从实体组件的 CraftingStation 配置中收集站点类型编号。 */
function collectStationTypesFromComponent(value: unknown, out: Set<number>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectStationTypesFromComponent(entry, out);
    return;
  }
  if (!isRecord(value)) return;
  const stationType = value.stationType;
  if (typeof stationType === "number" && Number.isInteger(stationType)) out.add(stationType);
}

/**
 * 收集配置中出现的站点类型：配方 stationType ∪ 实体 CraftingStation 配置。
 * 0 = 手搓（无站点），不作为站点类型输出。
 */
function collectStationTypes(gameDef: LoadedGameDefinition, crafting: CraftingRule | undefined): number[] {
  const types = new Set<number>();
  for (const recipe of crafting?.recipes ?? []) {
    const stationType = recipe.stationType;
    if (typeof stationType === "number" && Number.isInteger(stationType) && stationType !== 0) {
      types.add(stationType);
    }
  }
  for (const entity of gameDef.resolvedEntities) {
    collectStationTypesFromComponent(entity.components.CraftingStation, types);
  }
  return [...types].filter((type) => type !== 0).sort((a, b) => a - b);
}

/**
 * 递归收集 damageType 字符串与 resist 表的键。
 *
 * 只认配置中实际出现的字段名（协议机制词，大小写不敏感以兼容 PascalCase
 * 组件名），不解释具体类型语义；因此敌人原型将来在 Attack/自定义组件里声明
 * damageType 时也会被收集。
 */
function collectDamageTypesFromValue(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectDamageTypesFromValue(entry, out);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "damagetype" && typeof child === "string" && child.length > 0) {
      out.add(child);
      continue;
    }
    if (normalizedKey === "resist" && isRecord(child)) {
      for (const damageType of Object.keys(child)) {
        if (damageType.length > 0) out.add(damageType);
      }
      continue;
    }
    if (isRecord(child) || Array.isArray(child)) collectDamageTypesFromValue(child, out);
  }
}

/** 收集物品与实体配置中出现的伤害类型（去重后按字典序稳定输出）。 */
function collectDamageTypes(gameDef: LoadedGameDefinition): string[] {
  const types = new Set<string>();
  for (const item of gameDef.resolvedItems) {
    if (item.damageType) types.add(item.damageType);
    for (const damageType of Object.keys(item.resist ?? {})) {
      if (damageType.length > 0) types.add(damageType);
    }
  }
  for (const entity of gameDef.resolvedEntities) {
    collectDamageTypesFromValue(entity.components, types);
  }
  return [...types].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 构建内容目录（`/content` 响应体）。
 *
 * @param gameDef 已加载的游戏配置
 * @returns 内容目录（各段为空数组表示对应配置未声明；items 中未配置的机制字段省略）
 */
export function buildContentCatalog(gameDef: LoadedGameDefinition): ContentCatalog {
  const crafting = gameDef.resolvedRules["crafting"] as CraftingRule | undefined;
  const achievements = gameDef.resolvedRules["achievements"] as AchievementRule | undefined;
  const environment = gameDef.resolvedRules["environment"] as EnvironmentRule | undefined;
  const progression = gameDef.resolvedRules["progression"] as ProgressionRule | undefined;
  const factions = gameDef.resolvedRules["factions"] as FactionRule | undefined;
  const curve = resolveProgressionCurve(progression);

  return {
    items: gameDef.resolvedItems.map(toContentItem),
    recipes: (crafting?.recipes ?? []).map(toContentRecipe),
    quests: gameDef.resolvedQuests.map(toContentQuest),
    achievements: (achievements?.achievements ?? []).map(toContentAchievement),
    phases: (environment?.phases ?? []).map(toContentPhase),
    skills: Object.entries(progression?.skills ?? {}).map(([id, definition]) =>
      toContentSkill(id, definition, curve),
    ),
    factions: (factions?.factions ?? []).map(toContentFaction),
    stationTypes: collectStationTypes(gameDef, crafting).map((id) => ({
      id,
      label: resolveContentLabel("stationType", String(id)),
    })),
    damageTypes: collectDamageTypes(gameDef).map((id) => ({
      id,
      label: resolveContentLabel("damageType", id),
    })),
  };
}
