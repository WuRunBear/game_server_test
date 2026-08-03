import { z } from "zod";
import type { MapSource } from "framework/map/types";
import type { ArchetypeSpec } from "framework/entities/archetypeRegistry";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";

export const SystemEnableEntrySchema = z.object({
  id: z.string(),
  enabled: z.boolean().optional(),
  config: z.object({}).passthrough().optional(),
});

export const NetSyncFieldSchema = z.object({
  component: z.string(),
  fields: z.array(z.string()),
  /**
   * 可选：限定同步该字段的实体标签（bitecs tag 组件名）。
   * 用于 AoS 组件（非 bitecs 可查组件）限定查询范围，如 ItemMeta 仅同步 [Item] 实体。
   * SoA 组件条目通常不需要——直接按该组件查询。
   */
  tags: z.array(z.string()).optional(),
});

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
  netSync: z.object({
    fields: z.array(NetSyncFieldSchema),
  }).optional(),
});

export type GameDefinition = z.infer<typeof GameDefinitionSchema>;
export type SystemEnableEntry = z.infer<typeof SystemEnableEntrySchema>;
export type NetSyncField = z.infer<typeof NetSyncFieldSchema>;

export interface SpawnRule {
  kind: string;
  zoneId: number;
  max: number;
  respawnMs: number;
}

export interface BehaviorDefinition {
  id: string;
  definition: unknown;
}

export interface LoadedGameDefinition extends GameDefinition {
  resolvedMapSource?: MapSource;
  resolvedEntities: ArchetypeSpec[];
  resolvedBehaviors: BehaviorDefinition[];
  resolvedRules: Record<string, unknown>;
  resolvedSpawns: SpawnRule[];
  /** item kind 定义表（来自 game/items/*.json）。 */
  resolvedItems: ItemKindSpec[];
  /** 运行时索引：kind → ItemKindSpec。由 GameInstance 构造时填充。 */
  itemsByKind?: Map<string, ItemKindSpec>;
}
