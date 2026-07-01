import { describe, it, expect, beforeAll } from "vitest";
import { bootstrapFramework, createGameInstance, runHeadless, createDefaultGameDefinition } from "framework/index";
import { getRegistries } from "framework/bootstrap";

beforeAll(() => {
  bootstrapFramework();
});

describe("componentRegistry", () => {
  it("should have registered builtin components", () => {
    const { componentRegistry } = getRegistries();
    expect(componentRegistry.has("Transform")).toBe(true);
    expect(componentRegistry.has("Health")).toBe(true);
    expect(componentRegistry.has("NetworkId")).toBe(true);
    expect(componentRegistry.has("Player")).toBe(true);
    expect(componentRegistry.has("NPC")).toBe(true);
  });

  it("should throw on duplicate registration", () => {
    const { componentRegistry } = getRegistries();
    expect(() => componentRegistry.register("Transform", {})).toThrow("already registered");
  });
});

describe("systemRegistry", () => {
  it("should have registered builtin systems", () => {
    const { systemRegistry } = getRegistries();
    expect(systemRegistry.has("ai")).toBe(true);
    expect(systemRegistry.has("physics")).toBe(true);
    expect(systemRegistry.has("movement")).toBe(true);
    expect(systemRegistry.has("collision")).toBe(true);
    expect(systemRegistry.has("combat")).toBe(true);
  });
});

describe("actionRegistry", () => {
  it("should have registered builtin actions", () => {
    const { actionRegistry } = getRegistries();
    expect(actionRegistry.has("Idle")).toBe(true);
    expect(actionRegistry.has("Wander")).toBe(true);
  });

  it("should throw on unregistered action", () => {
    const { actionRegistry } = getRegistries();
    expect(() => actionRegistry.get("NonExistent")).toThrow("not registered");
  });
});

describe("archetypeRegistry", () => {
  it("should have registered builtin archetypes", () => {
    const { archetypeRegistry } = getRegistries();
    expect(archetypeRegistry.has("player")).toBe(true);
    expect(archetypeRegistry.has("villager")).toBe(true);
  });

  it("player archetype should have correct properties", () => {
    const { archetypeRegistry } = getRegistries();
    const player = archetypeRegistry.get("player");
    expect(player.tags).toContain("Player");
    expect(player.components.Health).toEqual({ current: 100, max: 100 });
    expect(player.team).toBe(1);
  });
});

describe("GameInstance headless", () => {
  it("should run ticks without error", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);

    expect(instance.world.time.tick).toBe(0);
    runHeadless(instance, { tickCount: 5 });
    expect(instance.world.time.tick).toBe(5);
  });
});
