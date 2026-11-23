/**
 * 客户端静态契约清单（framework/content/manifest.ts）——`GET /client/manifest` 的数据源。
 *
 * 目标：客户端**一次拉取**即拿到带版本的静态契约（地图/图块语义/实体表现/物品/
 * 规则常量/netSync 字段表），不再硬编码任何游戏内容。
 *
 * 分工（框架游戏无关）：
 * - 内容全部来自配置：`LoadedGameDefinition.resolved*`（物品/任务/规则）+
 *   表现配置（`game/presentation/*.json`，见 PresentationSchema）；
 * - 物品/势力/站点/伤害类型等目录段直接复用 `buildContentCatalog`
 *   （`/content` 的同一数据源，见 CC-09），不在 manifest 内重复扫描配置；
 * - 框架只做搬运与形态归一，不解释 category / visualId / tilesetId 等不透明
 *   id，也不落贴图路径/图集坐标/动画帧；
 * - 尚未实现的段（动画/音频/状态效果）输出空数组/空对象，不出现 `undefined`
 *   （字段可增不可减）。
 *
 * `contentVersion`：对**键序稳定**的规范 JSON 做 FNV-1a 32 位哈希，输出 8 位
 * 小写十六进制。覆盖表现配置 + 物品/配方/任务/成就/相位/技能 + 势力/站点/
 * 伤害类型 + netSync + tickRate/world tile + 地图/实体清单；同一配置跨进程
 * 稳定，任一段变化即变。
 */
import type { NetSyncField, LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type {
  EntityPresentation,
  MapConnectionSpec,
  MapMinimapSpec,
  MapPresentation,
  PresentationConfig,
  TileSemanticSpec,
  TileSemanticsTable,
} from "framework/config/schema/PresentationSchema";
import type {
  AchievementRule,
  CraftingRule,
  DialogueRule,
  EnvironmentRule,
  PlaceRule,
  ProgressionRule,
  ServerRule,
} from "framework/config/schema/RuleSchema";
import {
  buildContentCatalog,
  type ContentDamageType,
  type ContentFaction,
  type ContentStationType,
} from "framework/content/catalog";
import { contentLabelOf, resolveContentLabel } from "framework/content/labels";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "framework/net/protocol";

/* -------------------------------------------------------------------------- */
/* 响应类型（`ClientManifest` 是客户端消费的稳定契约）                          */
/* -------------------------------------------------------------------------- */

/** 世界基准（像素）。 */
export interface ClientManifestWorld {
  /** 单 tile 宽度（像素）。 */
  tileWidth: number;
  /** 单 tile 高度（像素）。 */
  tileHeight: number;
}

/**
 * 服务端规则常量（只输出客户端做 UI/预测需要且配置实际声明的键）。
 *
 * 来源：
 * - `viewRadius` / `maxMoveSpeed` / `maxCommandsPerSec` / `offlineRetentionTicks`
 *   ← `rules/server.json`；
 * - `placeRange` / `containerRange` ← `rules/place.json`；
 * - `talkRange` ← `rules/dialogue.json`；
 * - `stationRange` ← `rules/crafting.json`。
 *
 * 缺失的键**省略**（不编造默认值；客户端按自身策略回退）。
 */
export interface ClientManifestServerRules {
  /** 兴趣管理视野半径（像素）。 */
  viewRadius?: number;
  /** 移动输入合成速度上限（像素/秒）。 */
  maxMoveSpeed?: number;
  /** 命令频率上限（每秒条数）。 */
  maxCommandsPerSec?: number;
  /** 断线保留时长（tick）。 */
  offlineRetentionTicks?: number;
  /** 放置/拆除距离（像素）。 */
  placeRange?: number;
  /** 对话交互距离（像素）。 */
  talkRange?: number;
  /** 容器取回距离（像素）。 */
  containerRange?: number;
  /** 合成站点交互距离（像素）。 */
  stationRange?: number;
}

/** netSync 条目（同步段白名单）。 */
export interface ClientManifestNetSyncEntry {
  /** 组件名（SoA/AoS/派生投影伪组件）。 */
  component: string;
  /** 参与同步的字段名列表。 */
  fields: string[];
  /** 限定实体标签（无标签时为空数组，不省略）。 */
  tags: string[];
}

/** 地图连接（tile 坐标，配置能确定时才有 x/y）。 */
export interface ClientManifestMapConnection {
  /** 目标地图 key。 */
  to: string;
  /** 连接类型（不透明字符串）。 */
  kind: string;
  /** 入口 tile x。 */
  x?: number;
  /** 入口 tile y。 */
  y?: number;
}

/** 单图 manifest 条目。 */
export interface ClientManifestMap {
  /** 地图 key（`/maps/*` 端点的 mapId）。 */
  id: string;
  /** 展示名（表现配置缺条目时省略）。 */
  displayName?: string;
  /** 场景引用（不透明 id）。 */
  sceneId?: string;
  /** 图块集引用（不透明 id）。 */
  tilesetId?: string;
  /** 环境氛围引用（不透明 id）。 */
  ambientId?: string;
  /** 音乐引用（不透明 id）。 */
  musicId?: string;
  /** 小地图表现。 */
  minimap?: MapMinimapSpec;
  /**
   * 地图连接（配置有该图表现条目时恒为数组；表现缺条目时省略）。
   */
  connections?: ClientManifestMapConnection[];
  /**
   * 该图合并后的地面语义表（表现缺条目时省略；客户端回退顶层全局表）。
   */
  tileSemantics?: TileSemanticsTable;
  /** 层边界语义（有 quantize-terrain 的图才有）。 */
  levelSemantics?: { slope: number; cliff: number };
}

/** 单实体 kind 的 manifest 条目。 */
export interface ClientManifestEntity {
  /** 原型 kind。 */
  kind: string;
  /** 展示名（未配置时省略；客户端回退 kind）。 */
  displayName?: string;
  /** 分类（tags 推导；无 tags 为 "other"）。 */
  category: string;
  /** archetype 标签名（原样；无标签为空数组）。 */
  tags: string[];
  /** 尺寸（像素；archetype 无 Size 且表现配置未给时省略）。 */
  size?: { w: number; h: number };
  /** 锚点（缺省底部中心）。 */
  anchor: { x: number; y: number };
  /** 视觉引用（缺省 = kind）。 */
  visualId: string;
  /** 动画集引用（缺省 = kind）。 */
  animationSetId: string;
  /** 音频集引用（缺省 = kind）。 */
  audioSetId: string;
  /** 是否绘制投影。 */
  shadow: boolean;
}

/** 物品清单条目（轻量索引；完整物品数据仍走 `/content`）。 */
export interface ClientManifestItem {
  /** 物品 kind。 */
  kind: string;
  /** 展示名（游戏层登记名优先；未登记回退 kind 原文）。 */
  label: string;
  /** 单槽最大堆叠数（配置缺省时为 1）。 */
  maxStack: number;
}

/** `GET /client/manifest` 响应体。 */
export interface ClientManifest {
  /** 线上协议版本（破坏性 schema 变更时递增）。 */
  protocolVersion: number;
  /** Colyseus schema 基线版本（诊断用途）。 */
  schemaVersion: string;
  /** 内容版本（8 位小写十六进制；ETag 源）。 */
  contentVersion: string;
  /** 逻辑 tick 频率（次/秒）。 */
  tickRate: number;
  /** 世界基准。 */
  world: ClientManifestWorld;
  /** 服务端规则常量（缺失键省略）。 */
  serverRules: ClientManifestServerRules;
  /** 同步段白名单。 */
  netSync: ClientManifestNetSyncEntry[];
  /** 全部地图（覆盖地图 registry 全部 key）。 */
  maps: ClientManifestMap[];
  /** 全部实体原型 kind。 */
  entities: ClientManifestEntity[];
  /** 物品索引。 */
  items: ClientManifestItem[];
  /** 全局地面语义表（每图覆盖前的默认值）。 */
  tileSemantics: TileSemanticsTable;
  /** 动画集（CC-11 实现前为空对象）。 */
  animations: Record<string, unknown>;
  /** 音频集（CC-11 实现前为空对象）。 */
  audio: Record<string, unknown>;
  /** 状态效果（未实现，空数组）。 */
  statusEffects: unknown[];
  /** 伤害类型（来自 `/content` 的 catalog.damageTypes）。 */
  damageTypes: ContentDamageType[];
  /** 势力（来自 `/content` 的 catalog.factions）。 */
  factions: ContentFaction[];
  /** 合成站点类型（来自 `/content` 的 catalog.stationTypes）。 */
  stationTypes: ContentStationType[];
}

/* -------------------------------------------------------------------------- */
/* 稳定哈希（键序无关）                                                        */
/* -------------------------------------------------------------------------- */

/** 递归排序对象键（数组保持顺序——顺序是内容的一部分）；丢弃 undefined 值。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child === undefined) continue;
      sorted[key] = canonicalize(child);
    }
    return sorted;
  }
  return value;
}

/**
 * 键序稳定的 JSON 序列化：对象键递归排序后再 `JSON.stringify`。
 *
 * 哈希输入必须与对象属性插入顺序无关——同一配置从不同文件/不同加载顺序
 * 构造出的对象应得到同一字符串。数组顺序保留（数组序即内容序）。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** FNV-1a 32 位哈希（UTF-8 字节流 → 8 位小写十六进制）。 */
function fnv1a32Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * `contentVersion` 哈希输入（各段缺省为空表/空数组——形状恒定）。
 *
 * 注意：`items` / `recipes` / `quests` / `achievements` / `phases` / `skills`
 * 接收**完整配置对象**（不是 manifest 投影），因此物品效果、配方输入等
 * 客户端可见数据的任何变化都会推进版本。
 */
export interface ContentVersionInput {
  /** 表现配置（maps / entities / tileSemantics）。 */
  presentation?: {
    tileSemantics?: TileSemanticsTable;
    maps?: Record<string, MapPresentation>;
    entities?: Record<string, EntityPresentation>;
  };
  /** 地图 key 清单（新增/删除地图即变）。 */
  mapIds?: readonly string[];
  /** 实体 kind 清单（新增/删除原型即变）。 */
  entityKinds?: readonly string[];
  /** 实体 manifest 可见的 archetype 投影（kind / tags / Size）。 */
  entityArchetypes?: readonly unknown[];
  /** 物品定义全量。 */
  items?: readonly unknown[];
  /** 合成配方全量。 */
  recipes?: readonly unknown[];
  /** 任务定义全量。 */
  quests?: readonly unknown[];
  /** 成就定义全量。 */
  achievements?: readonly unknown[];
  /** 环境相位全量。 */
  phases?: readonly unknown[];
  /** 技能表（对象）。 */
  skills?: unknown;
  /** netSync 白名单（归一后条目）。 */
  netSync?: readonly unknown[];
  /** 势力目录（来自 buildContentCatalog）。 */
  factions?: readonly unknown[];
  /** 合成站点类型目录（来自 buildContentCatalog）。 */
  stationTypes?: readonly unknown[];
  /** 伤害类型目录（来自 buildContentCatalog）。 */
  damageTypes?: readonly unknown[];
  /** 服务端规则常量（manifest 可见键）。 */
  serverRules?: ClientManifestServerRules;
  /** 逻辑 tick 频率。 */
  tickRate?: number;
  /** 世界基准（tile 像素）。 */
  world?: { tileWidth?: number; tileHeight?: number };
}

/**
 * 计算内容版本（纯函数）：键序稳定 JSON → FNV-1a 32 → 8 位十六进制。
 *
 * 同一配置跨进程/跨加载顺序稳定；输入任一段变化即变。
 */
export function computeContentVersion(input: ContentVersionInput = {}): string {
  const canonical = {
    presentation: input.presentation ?? {},
    mapIds: input.mapIds ?? [],
    entityKinds: input.entityKinds ?? [],
    entityArchetypes: input.entityArchetypes ?? [],
    items: input.items ?? [],
    recipes: input.recipes ?? [],
    quests: input.quests ?? [],
    achievements: input.achievements ?? [],
    phases: input.phases ?? [],
    skills: input.skills ?? {},
    netSync: input.netSync ?? [],
    factions: input.factions ?? [],
    stationTypes: input.stationTypes ?? [],
    damageTypes: input.damageTypes ?? [],
    serverRules: input.serverRules ?? {},
    tickRate: input.tickRate ?? null,
    world: {
      tileWidth: input.world?.tileWidth ?? null,
      tileHeight: input.world?.tileHeight ?? null,
    },
  };
  return fnv1a32Hex(stableStringify(canonical));
}

/* -------------------------------------------------------------------------- */
/* Manifest 构建                                                               */
/* -------------------------------------------------------------------------- */

/** `buildClientManifest` 的可选注入参数。 */
export interface BuildClientManifestOptions {
  /**
   * 注入表现配置（缺省取 `gameDef.resolvedPresentation`）。
   *
   * 用于测试「表现输入变化 → contentVersion 变化」，以及同进程多游戏并存时
   * 显式指定数据源（避免依赖模块级活动配置）。
   */
  presentation?: PresentationConfig;
}

/** 缺省实体锚点（底部中心）。 */
const DEFAULT_ANCHOR = Object.freeze({ x: 0.5, y: 1 });

/** 生物类分类（决定缺省投影开关）。 */
const CREATURE_CATEGORIES = new Set(["player", "enemy", "npc"]);

/**
 * archetype tags / components → 实体分类，优先级与运行时 `Category.value`
 * （`framework/simulation/aosSyncAdapters.ts` 的 `categoryOf`）保持一致：
 *
 * Player > Enemy > NPC > Projectile 组件 > Structure/Placeable 组件 >
 * Resource > Container > Item > other。
 *
 * 分类字符串是通用机制词，不含任何游戏名词。表现配置显式给出 category 时
 * 以配置为准（用于客户端自定义分层/皮肤），否则按本函数推导。
 */
const EARLY_TAG_CATEGORIES = [
  ["Player", "player"],
  ["Enemy", "enemy"],
  ["NPC", "npc"],
] as const;

const LATE_TAG_CATEGORIES = [
  ["Resource", "resource"],
  ["Container", "container"],
  ["Item", "item"],
] as const;

function hasComponentConfig(components: Record<string, unknown>, name: string): boolean {
  return Object.hasOwn(components, name);
}

function categoryOfArchetype(tags: readonly string[], components: Record<string, unknown>): string {
  for (const [tag, category] of EARLY_TAG_CATEGORIES) {
    if (tags.includes(tag)) return category;
  }
  if (hasComponentConfig(components, "Projectile")) return "projectile";
  if (hasComponentConfig(components, "Structure") || hasComponentConfig(components, "Placeable")) {
    return "structure";
  }
  for (const [tag, category] of LATE_TAG_CATEGORIES) {
    if (tags.includes(tag)) return category;
  }
  return "other";
}

/** 普通对象收窄（排除 null 与数组）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 稳定 id 比较（UTF-16 码元序，而非 locale 相关排序）。
 *
 * `localeCompare` 受进程 locale/ICU 影响，跨机器可能给出不同顺序；
 * manifest 数组顺序参与内容哈希，必须与运行环境无关。
 */
function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 从 archetype `components.Size` 读取像素尺寸（加载后已归一为 px）。 */
function sizeFromArchetype(components: Record<string, unknown>): { w: number; h: number } | undefined {
  const size = asRecord(components["Size"]);
  if (!size) return undefined;
  const w = size.w;
  const h = size.h;
  if (typeof w !== "number" || !Number.isFinite(w) || w <= 0) return undefined;
  if (typeof h !== "number" || !Number.isFinite(h) || h <= 0) return undefined;
  return { w, h };
}

/** 取规则模块中某个有限数值字段（缺失/非数值返回 undefined）。 */
function numericRuleField(source: unknown, key: string): number | undefined {
  const value = asRecord(source)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 组装服务端规则段：只搬运配置实际声明的数值，缺失键省略。
 *
 * 各字段来源见 `ClientManifestServerRules` 文档；不在这里写任何默认值。
 */
function buildServerRules(rules: Record<string, unknown>): ClientManifestServerRules {
  const result: ClientManifestServerRules = {};
  const server = rules["server"] as ServerRule | undefined;
  const place = rules["place"] as PlaceRule | undefined;
  const dialogue = rules["dialogue"] as DialogueRule | undefined;
  const crafting = rules["crafting"] as CraftingRule | undefined;

  const add = (key: keyof ClientManifestServerRules, value: number | undefined): void => {
    if (value !== undefined) result[key] = value;
  };

  add("viewRadius", numericRuleField(server, "viewRadius"));
  add("maxMoveSpeed", numericRuleField(server, "maxMoveSpeed"));
  add("maxCommandsPerSec", numericRuleField(server, "maxCommandsPerSec"));
  add("offlineRetentionTicks", numericRuleField(server, "offlineRetentionTicks"));
  add("placeRange", numericRuleField(place, "placeRange"));
  add("talkRange", numericRuleField(dialogue, "talkRange"));
  add("containerRange", numericRuleField(place, "containerRange"));
  add("stationRange", numericRuleField(crafting, "stationRange"));

  return result;
}

/** netSync 条目归一：tags 恒为数组（配置缺省时为空数组）。 */
function buildNetSync(fields: readonly NetSyncField[] | undefined): ClientManifestNetSyncEntry[] {
  return (fields ?? []).map((entry) => ({
    component: entry.component,
    fields: [...entry.fields],
    tags: [...(entry.tags ?? [])],
  }));
}

/** 单图合并后的 tile 语义（全局 + 该图覆盖；无表现为空对象）。 */
function mergedTileSemantics(
  presentation: PresentationConfig | undefined,
  mapId: string,
): TileSemanticsTable {
  if (!presentation) return {};
  const override = presentation.maps[mapId]?.tileSemantics ?? {};
  return { ...presentation.tileSemantics, ...override };
}

/** 地图连接条目（只搬运配置声明的字段）。 */
function toMapConnection(connection: MapConnectionSpec): ClientManifestMapConnection {
  const entry: ClientManifestMapConnection = { to: connection.to, kind: connection.kind };
  if (connection.x !== undefined) entry.x = connection.x;
  if (connection.y !== undefined) entry.y = connection.y;
  return entry;
}

/** 单图 manifest 条目（表现缺失时只出 id；其余字段省略）。 */
function toMapManifest(
  id: string,
  spec: MapPresentation | undefined,
  presentation: PresentationConfig | undefined,
): ClientManifestMap {
  // 表现配置缺该图条目：只给稳定 id（客户端回退顶层 tileSemantics / 自身默认）
  if (!spec) return { id };

  const entry: ClientManifestMap = {
    id,
    connections: (spec.connections ?? []).map(toMapConnection),
    tileSemantics: mergedTileSemantics(presentation, id),
  };
  if (spec.displayName !== undefined) entry.displayName = spec.displayName;
  if (spec.sceneId !== undefined) entry.sceneId = spec.sceneId;
  if (spec.tilesetId !== undefined) entry.tilesetId = spec.tilesetId;
  if (spec.ambientId !== undefined) entry.ambientId = spec.ambientId;
  if (spec.musicId !== undefined) entry.musicId = spec.musicId;
  if (spec.minimap !== undefined) entry.minimap = { ...spec.minimap };
  if (spec.levelSemantics !== undefined) entry.levelSemantics = { ...spec.levelSemantics };
  return entry;
}

/** 单实体 manifest 条目（archetype 数据 + 可缺省的表现配置）。 */
function toEntityManifest(
  archetype: LoadedGameDefinition["resolvedEntities"][number],
  spec: EntityPresentation | undefined,
): ClientManifestEntity {
  const tags = [...(archetype.tags ?? [])];
  const category = spec?.category ?? categoryOfArchetype(tags, archetype.components);
  const displayName = spec?.displayName ?? contentLabelOf("entity", archetype.kind);
  const size = sizeFromArchetype(archetype.components) ?? spec?.size;
  const anchor = spec?.anchor ?? DEFAULT_ANCHOR;

  const entry: ClientManifestEntity = {
    kind: archetype.kind,
    category,
    tags,
    anchor: { x: anchor.x, y: anchor.y },
    visualId: spec?.visualId ?? archetype.kind,
    animationSetId: spec?.animationSetId ?? archetype.kind,
    audioSetId: spec?.audioSetId ?? archetype.kind,
    shadow: spec?.shadow ?? CREATURE_CATEGORIES.has(category),
  };
  if (displayName !== undefined) entry.displayName = displayName;
  if (size !== undefined) entry.size = { w: size.w, h: size.h };
  return entry;
}

/** 物品条目（轻量索引；maxStack 未配置时按 schema 语义取 1）。 */
function toItemManifest(spec: LoadedGameDefinition["resolvedItems"][number]): ClientManifestItem {
  return {
    kind: spec.kind,
    label: resolveContentLabel("item", spec.kind),
    maxStack: spec.maxStack ?? 1,
  };
}

/**
 * 构建客户端静态契约。
 *
 * 纯函数：只读 `gameDef`（与可选注入的表现配置），不读全局活动配置、不写状态。
 * 输出数组顺序稳定（地图按 registry 顺序；实体/物品按 kind 排序），便于 ETag
 * 与跨进程比较。
 *
 * @param gameDef 已加载的游戏定义（loadGameDefinition 产物）
 * @param options 可选注入（表现配置）
 */
export function buildClientManifest(
  gameDef: LoadedGameDefinition,
  options?: BuildClientManifestOptions,
): ClientManifest {
  const presentation = options?.presentation ?? gameDef.resolvedPresentation;

  // 目录段（势力/站点/伤害类型）复用 `/content` 的同一构建函数，不在这里
  // 重复扫描配置；配置启动后不变，buildClientManifest 本身也会被 HTTP 层缓存。
  const contentCatalog = buildContentCatalog(gameDef);

  const netSync = buildNetSync(gameDef.netSync?.fields);
  const serverRules = buildServerRules(gameDef.resolvedRules);

  const maps = gameDef.resolvedMapConfigs.map((config) =>
    toMapManifest(config.key, presentation?.maps[config.key], presentation),
  );

  const entities = [...gameDef.resolvedEntities]
    .sort((a, b) => compareId(a.kind, b.kind))
    .map((archetype) => toEntityManifest(archetype, presentation?.entities?.[archetype.kind]));

  const items = [...gameDef.resolvedItems]
    .sort((a, b) => compareId(a.kind, b.kind))
    .map(toItemManifest);

  const crafting = gameDef.resolvedRules["crafting"] as CraftingRule | undefined;
  const achievements = gameDef.resolvedRules["achievements"] as AchievementRule | undefined;
  const environment = gameDef.resolvedRules["environment"] as EnvironmentRule | undefined;
  const progression = gameDef.resolvedRules["progression"] as ProgressionRule | undefined;

  const contentVersion = computeContentVersion({
    presentation: presentation
      ? {
          tileSemantics: presentation.tileSemantics,
          maps: presentation.maps,
          entities: presentation.entities ?? {},
        }
      : {},
    mapIds: gameDef.resolvedMapConfigs.map((config) => config.key),
    entityKinds: entities.map((entity) => entity.kind),
    entityArchetypes: gameDef.resolvedEntities
      .slice()
      .sort((a, b) => compareId(a.kind, b.kind))
      .map((archetype) => ({
        kind: archetype.kind,
        tags: [...(archetype.tags ?? [])],
        size: sizeFromArchetype(archetype.components) ?? null,
      })),
    // 物品/任务来自目录扫描（readdir 顺序不保证跨进程一致）——按 id 排序后再哈希
    items: [...gameDef.resolvedItems].sort((a, b) => compareId(a.kind, b.kind)),
    recipes: crafting?.recipes ?? [],
    quests: [...gameDef.resolvedQuests].sort((a, b) => compareId(a.id, b.id)),
    achievements: achievements?.achievements ?? [],
    phases: environment?.phases ?? [],
    skills: progression?.skills ?? {},
    netSync,
    factions: contentCatalog.factions,
    stationTypes: contentCatalog.stationTypes,
    damageTypes: contentCatalog.damageTypes,
    serverRules,
    tickRate: gameDef.tickRate,
    world: {
      tileWidth: gameDef.world.tile.width,
      tileHeight: gameDef.world.tile.height,
    },
  });

  return {
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    contentVersion,
    tickRate: gameDef.tickRate,
    world: {
      tileWidth: gameDef.world.tile.width,
      tileHeight: gameDef.world.tile.height,
    },
    serverRules,
    netSync,
    maps,
    entities,
    items,
    tileSemantics: presentation?.tileSemantics ?? {},
    animations: {},
    audio: {},
    statusEffects: [],
    damageTypes: contentCatalog.damageTypes,
    factions: contentCatalog.factions,
    stationTypes: contentCatalog.stationTypes,
  };
}
