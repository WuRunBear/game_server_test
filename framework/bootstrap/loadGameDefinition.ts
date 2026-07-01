import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { GameDefinitionSchema, type GameDefinition } from "framework/config/schema/GameDefinitionSchema";

export interface LoadGameDefinitionOptions {
  gameJsonPath?: string;
}

export function loadGameDefinition(options?: LoadGameDefinitionOptions): GameDefinition {
  const jsonPath = resolve(
    process.cwd(),
    options?.gameJsonPath ?? "game/game.json",
  );

  if (!existsSync(jsonPath)) {
    return createDefaultGameDefinition();
  }

  const raw = readFileSync(jsonPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const result = GameDefinitionSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error(
      `Invalid game definition at ${jsonPath}: ${result.error.message}`,
    );
  }

  return result.data;
}

export function createDefaultGameDefinition(): GameDefinition {
  return {
    id: "default",
    name: "默认游戏",
    tickRate: 20,
    systems: [
      { id: "ai" },
      { id: "physics" },
      { id: "movement" },
      { id: "collision" },
      { id: "combat" },
      { id: "inventory" },
      { id: "interaction" },
    ],
    netSync: {
      fields: [
        { component: "Transform", fields: ["x", "y"] },
        { component: "Health", fields: ["current"] },
        { component: "Collider", fields: ["shape", "radius"] },
        { component: "Size", fields: ["w", "h"] },
      ],
    },
  };
}
