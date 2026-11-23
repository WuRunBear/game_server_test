import { bootstrapFramework } from "framework/bootstrap";
import { registerContentLabel } from "framework";

// 由 src/main.ts 在启动链最前 import 执行，使其中的自定义扩展注册先于 createGameInstance。
bootstrapFramework();

// 游戏自定义扩展注册（框架功能之外的 src 专属实现）写在这里：
// 使用 framework/api 的 registerSystem / registerComponent / registerArchetype /
// registerAction / registerRuleModule，地图生成积木经
// getRegistries().mapGeneratorRegistry.register()；新签名支持可选
// description / configSchema 元数据（见 docs/CONFIG-EDITOR-PLAN.md §Phase A3）。

// ---------------------------------------------------------------------------
// 内容展示名（游戏层持有中文名；框架只做查表与兜底）
//
// 用途：`GET /content` 端点返回的静态表需要可读的名称——配置里多数条目只有
// id/kind（物品、配方、任务都没有 name 字段），若无展示名，客户端只能显示
// "wood" / "collect_axe" 这类原文。框架不含任何游戏名词（见 AGENTS.md 铁律），
// 故中文名在此注册：`registerContentLabel(scope, id, 展示名)`。
//
// 兜底链：配置自带字段（成就的 name/description）→ 本表登记名 → id/kind 原文。
// ---------------------------------------------------------------------------

/** 物品 kind → 中文名。 */
const ITEM_LABELS: Record<string, string> = {
  axe: "斧头",
  berry: "浆果",
  berry_pie: "浆果派",
  boss_cleaver: "巨兽巨刃",
  boss_core: "首领核心",
  campfire_kit: "篝火套件",
  cooked_meat: "熟肉",
  door_kit: "门套件",
  fence_kit: "栅栏套件",
  floor_kit: "地板套件",
  furniture_kit: "家具套件",
  pickaxe: "镐",
  plank: "木板",
  raw_meat: "生肉",
  rotten: "腐肉",
  sap: "树液",
  shell: "贝壳",
  shell_armor: "贝壳甲",
  shell_spear: "贝壳长矛",
  spear: "长矛",
  stairs_down_kit: "下行楼梯套件",
  stairs_up_kit: "上行楼梯套件",
  stone: "石头",
  stone_axe: "石斧",
  throwing_spear: "投掷矛",
  twig: "树枝",
  wall_kit: "墙套件",
  water: "水",
  wood: "木头",
};

/** 合成配方 id → 中文名。 */
const RECIPE_LABELS: Record<string, string> = {
  wood_axe: "木斧",
  stone_axe: "石斧",
  pickaxe: "镐",
  spear: "长矛",
  berry_pie: "浆果派",
  cooked_meat: "熟肉",
  campfire_kit: "篝火",
  wall_kit: "墙",
  floor_kit: "地板",
  fence_kit: "栅栏",
  stairs_up_kit: "上行楼梯",
  stairs_down_kit: "下行楼梯",
  plank: "木板",
  throwing_spear: "投掷矛",
  door_kit: "门",
  furniture_kit: "家具",
  shell_spear: "贝壳长矛",
  shell_armor: "贝壳甲",
  boss_cleaver: "巨兽巨刃",
};

/** 任务 id → 中文名。 */
const QUEST_LABELS: Record<string, string> = {
  collect_axe: "带来一把斧头",
  hunt_task: "猎杀恶兽",
};

/** 实体 kind → 中文名（任务目标等描述里引用实体时用）。 */
const ENTITY_LABELS: Record<string, string> = {
  wolf: "狼",
};

/** 技能 id → 中文名。 */
const SKILL_LABELS: Record<string, string> = {
  combat: "战斗",
  gathering: "采集",
};

/** 成就 id → 中文名（配置自带 name 时以配置为准，此处仅作兜底）。 */
const ACHIEVEMENT_LABELS: Record<string, string> = {
  village_friend: "渔村的熟人",
  boss_slayer: "巨兽克星",
};

/** 合成站点类型编号 → 中文名（仅展示名；编号语义仍由配置的 stationType 决定）。 */
const STATION_TYPE_LABELS: Record<string, string> = {
  "1": "篝火",
};

for (const [kind, label] of Object.entries(ITEM_LABELS)) {
  registerContentLabel("item", kind, label);
}
for (const [kind, label] of Object.entries(ENTITY_LABELS)) {
  registerContentLabel("entity", kind, label);
}
for (const [id, label] of Object.entries(RECIPE_LABELS)) {
  registerContentLabel("recipe", id, label);
}
for (const [id, label] of Object.entries(QUEST_LABELS)) {
  registerContentLabel("quest", id, label);
}
for (const [id, label] of Object.entries(SKILL_LABELS)) {
  registerContentLabel("skill", id, label);
}
for (const [id, label] of Object.entries(ACHIEVEMENT_LABELS)) {
  registerContentLabel("achievement", id, label);
}
for (const [id, label] of Object.entries(STATION_TYPE_LABELS)) {
  registerContentLabel("stationType", id, label);
}
