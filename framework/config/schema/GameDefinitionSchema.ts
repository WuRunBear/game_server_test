import { z } from "zod";
import type { MapSource } from "framework/map/types";
import type { ArchetypeSpec } from "framework/entities/archetypeRegistry";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";
import type { DialogueTreeJson } from "framework/config/schema/DialogueSchema";
import type { QuestDefinitionJson } from "framework/config/schema/QuestSchema";

/**
 * 游戏定义（game/game.json）配置 schema——「配置驱动」框架的入口配置。
 *
 * GameDefinitionSchema 描述 game.json 的字段结构；其中 entities/behaviors/rules/
 * spawns/items/dialogues/quests 为相对路径字符串（支持 * 通配），指向同目录下的
 * 内容文件，由 loadGameDefinition（framework/bootstrap/loadGameDefinition.ts）
 * 加载并解析为 LoadedGameDefinition 的 resolved* 字段（类型见文件尾部接口）。
 * zod 校验保证结构与类型安全：加载失败即抛错，避免错误配置进入运行时。
 */

/**
 * 系统启用条目（game.json 的 systems[] 元素）：
 * - id：引用系统注册表（registerSystem）中的系统名
 * - enabled：是否启用（缺省启用；false 用于停用默认开启的系统，如替换内置系统时）
 * - config：系统级配置（透传给系统工厂，内部结构不校验）
 */
export const SystemEnableEntrySchema = z.object({
  id: z.string(),
  enabled: z.boolean().optional(),
  config: z.object({}).passthrough().optional(),
});

/**
 * 网络同步字段条目（game.json 的 netSync.fields[] 元素）：
 * 声明把某组件（component）的若干字段（fields）同步给客户端。
 */
export const NetSyncFieldSchema = z.object({
  /** 要同步的组件名（SoA 组件或 AoS 组件）。 */
  component: z.string(),
  /** 要同步的字段名列表（AoS 组件按字段展平为 numbers/strings）。 */
  fields: z.array(z.string()),
  /**
   * 可选：限定同步该字段的实体标签（bitecs tag 组件名）。
   * 用于 AoS 组件（非 bitecs 可查组件）限定查询范围，如 ItemMeta 仅同步 [Item] 实体。
   * SoA 组件条目通常不需要——直接按该组件查询。
   */
  tags: z.array(z.string()).optional(),
});

/**
 * 游戏定义根 schema（game/game.json）：
 * - id/name：定义标识与显示名
 * - worldview：世界观/主题透传（不校验内部）
 * - tickRate：逻辑 tick 频率（次/秒）
 * - map：地图清单路径（registry）与默认地图（default）
 * - systems：启用的系统列表（见 SystemEnableEntrySchema）
 * - entities/behaviors/rules/spawns/items/dialogues/quests：各内容文件路径
 * - netSync：网络同步字段配置（见 NetSyncFieldSchema）
 */
export const GameDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  worldview: z.object({}).passthrough().optional(),
  tickRate: z.number().min(1),
  map: z.object({
    registry: z.string(),
    default: z.string().optional(),
  }).optional(),
  systems: z.array(SystemEnableEntrySchema).optional(),
  entities: z.string().optional(),
  behaviors: z.string().optional(),
  rules: z.string().optional(),
  spawns: z.string().optional(),
  items: z.string().optional(),
  /** 对话树配置段（game/dialogues/*.json）。 */
  dialogues: z.string().optional(),
  /** 任务定义配置段（game/quests/*.json）。 */
  quests: z.string().optional(),
  netSync: z.object({
    fields: z.array(NetSyncFieldSchema),
  }).optional(),
});

/** 游戏定义 JSON 的类型推断（即 game/game.json 根对象类型）。 */
export type GameDefinition = z.infer<typeof GameDefinitionSchema>;
/** 系统启用条目的类型推断。 */
export type SystemEnableEntry = z.infer<typeof SystemEnableEntrySchema>;
/** 网络同步字段条目的类型推断。 */
export type NetSyncField = z.infer<typeof NetSyncFieldSchema>;

export interface SpawnRule {
  kind: string;
  zoneId: number;
  max: number;
  respawnMs: number;
  /** 可选刷怪条件（引用 spawnConditions 注册表，如 "isNight"）。 */
  condition?: string;
  /** 可选限定生效的地图 id（缺省全部地图生效）。 */
  mapId?: string;
}

/** 行为树定义：id + 不透明 definition（来自 game/behaviors/*.json）。 */
export interface BehaviorDefinition {
  id: string;
  definition: unknown;
}

/** 加载完成后的游戏定义：game.json 校验结果 + 各内容文件解析结果。 */
export interface LoadedGameDefinition extends GameDefinition {
  resolvedMapSource?: MapSource;
  /** 全部地图来源（maps/registry.json 的 maps 表，key=地图 id）——portal 场景切换用。 */
  resolvedMapSources?: Record<string, MapSource>;
  /** 实体原型定义表（来自 game/entities/*.json）。 */
  resolvedEntities: ArchetypeSpec[];
  /** 行为树定义表（来自 game/behaviors/*.json）。 */
  resolvedBehaviors: BehaviorDefinition[];
  /** 规则表：规则文件基名 → 规则内容（已注册 schema 的经 zod 校验）。 */
  resolvedRules: Record<string, unknown>;
  /** 刷怪规则列表（来自 game/spawns/*.json）。 */
  resolvedSpawns: SpawnRule[];
  /** item kind 定义表（来自 game/items/*.json）。 */
  resolvedItems: ItemKindSpec[];
  /** 对话树定义表（来自 game/dialogues/*.json）。 */
  resolvedDialogues: DialogueTreeJson[];
  /** 任务定义表（来自 game/quests/*.json）。 */
  resolvedQuests: QuestDefinitionJson[];
  /** 运行时索引：kind → ItemKindSpec。由 GameInstance 构造时填充。 */
  itemsByKind?: Map<string, ItemKindSpec>;
  /** 运行时索引：treeId → DialogueTreeJson。由 GameInstance 构造时填充。 */
  dialoguesByKind?: Map<string, DialogueTreeJson>;
  /** 运行时索引：questId → QuestDefinitionJson。由 GameInstance 构造时填充。 */
  questsByKind?: Map<string, QuestDefinitionJson>;
}
