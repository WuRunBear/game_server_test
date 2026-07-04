import { z } from "zod";

export const BehaviorSchema = z.object({
  id: z.string(),
  definition: z.unknown(),
});

export type BehaviorSchemaJson = z.infer<typeof BehaviorSchema>;
