import type { ArchetypeRegistry } from "framework/entities/archetypeRegistry";

export function registerBuiltinArchetypes(registry: ArchetypeRegistry): void {
  registry.register({
    kind: "player",
    tags: ["Player"],
    components: {
      Size: { w: 16, h: 16 },
      Velocity: {},
      Acceleration: {},
      Collider: { shape: 1, halfW: 8, halfH: 8 },
      Health: { current: 100, max: 100 },
    },
    team: 1,
  });

  registry.register({
    kind: "villager",
    tags: ["NPC"],
    components: {
      Size: { w: 16, h: 16 },
      Velocity: {},
      Collider: { shape: 1, halfW: 8, halfH: 8 },
      Health: { current: 50, max: 50 },
    },
    behavior: "wander-default",
    team: 0,
  });
}
