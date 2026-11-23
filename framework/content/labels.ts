/**
 * 内容展示名登记表（framework/content/labels.ts）。
 *
 * 目的：让 `/content` 端点与协议层能给出**可读的展示名**，而框架本身不携带
 * 任何游戏语义——展示名由游戏层（src/register.ts）注册，框架只做查表与兜底。
 *
 * 分工：
 * - 框架：注册表 + 兜底策略（查不到 → 用配置里的 id/kind 原文）；
 * - 游戏：`registerContentLabel("item", "<kind>", "<展示名>")` 逐项注册本地化名称。
 *
 * 兜底链（内容目录构建时按此顺序取值）：
 * 1. 配置里自带的名称字段（如成就的 name/description）；
 * 2. 本表登记的展示名（游戏层注册）；
 * 3. 配置 id / kind 原文（配置里的原始标识符）。
 *
 * 语义键（scope）保持通用机制词，不含游戏名词。
 */

/** 展示名作用域（通用机制词）。 */
export type ContentLabelScope =
  | "item"
  | "entity"
  | "quest"
  | "achievement"
  | "recipe"
  | "skill"
  | "faction"
  | "stationType"
  | "damageType";

/** scope → (id → 展示名) */
const labelsByScope = new Map<ContentLabelScope, Map<string, string>>();

/**
 * 注册一条展示名（游戏层调用；重复注册以最后一次为准）。
 *
 * @param scope 作用域（物品/任务/成就/配方/技能）
 * @param id 配置内的 id（物品 kind、任务 id、配方 id……）
 * @param label 展示名（通常是本地化名称）
 */
export function registerContentLabel(scope: ContentLabelScope, id: string, label: string): void {
  let byId = labelsByScope.get(scope);
  if (!byId) {
    byId = new Map<string, string>();
    labelsByScope.set(scope, byId);
  }
  byId.set(id, label);
}

/**
 * 查展示名（未注册返回 undefined——调用方走兜底链）。
 *
 * @param scope 作用域
 * @param id 配置内的 id
 */
export function contentLabelOf(scope: ContentLabelScope, id: string): string | undefined {
  return labelsByScope.get(scope)?.get(id);
}

/**
 * 展示名兜底：登记名优先，否则用配置 id/kind 原文。
 *
 * @param scope 作用域
 * @param id 配置内的 id
 */
export function resolveContentLabel(scope: ContentLabelScope, id: string): string {
  return contentLabelOf(scope, id) ?? id;
}

/**
 * 物品 kind → 展示名（含已注册的中文名；未注册返回 kind 原文）。
 *
 * 供内容目录之外的场景复用（如对话/任务描述里提到某物品时的可读化）。
 *
 * @param kind 物品 kind
 */
export function itemLabelOf(kind: string): string {
  return resolveContentLabel("item", kind);
}

/**
 * 清空登记表（测试用：避免跨用例串扰）。
 */
export function resetContentLabels(): void {
  labelsByScope.clear();
}
