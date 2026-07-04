import { z } from "zod";

export const GeneratedMapEntrySchema = z.object({
  kind: z.literal("generated"),
  generatorId: z.string().default("simple"),
  id: z.string().optional(),
  name: z.string().optional(),
  seed: z.number().default(1),
  width: z.number().default(64),
  height: z.number().default(64),
  tileWidth: z.number().default(16),
  tileHeight: z.number().default(16),
});

export const TiledMapEntrySchema = z.object({
  kind: z.literal("tiled"),
  path: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
});

export const MapEntrySchema = z.discriminatedUnion("kind", [
  GeneratedMapEntrySchema,
  TiledMapEntrySchema,
]);

export const MapRegistrySchema = z.object({
  default: z.string().optional(),
  maps: z.record(z.string(), MapEntrySchema),
});

export type MapRegistryJson = z.infer<typeof MapRegistrySchema>;
export type GeneratedMapEntryJson = z.infer<typeof GeneratedMapEntrySchema>;
export type TiledMapEntryJson = z.infer<typeof TiledMapEntrySchema>;
