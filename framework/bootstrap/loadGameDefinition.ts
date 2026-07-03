import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { GameDefinitionSchema, type GameDefinition } from "framework/config/schema/GameDefinitionSchema";
import { getRegistries } from "framework/bootstrap";

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

  validateIntegrity(result.data);

  return result.data;
}

function validateIntegrity(gameDef: GameDefinition): void {
  try {
    const { systemRegistry } = getRegistries();
    for (const entry of gameDef.systems ?? []) {
      if (!systemRegistry.has(entry.id)) {
        throw new Error(`System "${entry.id}" referenced in game config is not registered`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("not bootstrapped")) {
      return;
    }
    throw err;
  }
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
