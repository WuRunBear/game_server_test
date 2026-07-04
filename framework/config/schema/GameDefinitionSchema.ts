import { z } from "zod";
import type { MapSource } from "framework/map/types";
import type { ArchetypeSpec } from "framework/entities/archetypeRegistry";

export const SystemEnableEntrySchema = z.object({
  id: z.string(),
  enabled: z.boolean().optional(),
  config: z.object({}).passthrough().optional(),
});

export const NetSyncFieldSchema = z.object({
  component: z.string(),
  fields: z.array(z.string()),
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
}
