import { z } from "zod";

const ComponentFieldsSchema = z.record(z.string(), z.unknown());

export const ArchetypeSchema = z.object({
  kind: z.string(),
  tags: z.array(z.string()).optional(),
  components: z.record(z.string(), ComponentFieldsSchema),
  behavior: z.string().optional(),
  team: z.number().optional(),
});

export type ArchetypeSchemaJson = z.infer<typeof ArchetypeSchema>;
