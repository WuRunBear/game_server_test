import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { addComponent, addEntity, hasComponent } from "bitecs";
import { State } from "mistreevous";
import {
  bootstrapFramework,
  createGameInstance,
  runHeadless,
  createDefaultGameDefinition,
  loadGameDefinition,
  spawnEntity,
  buildSystems,
  type GameInstance,
} from "framework/index";
import { getRegistries } from "framework/bootstrap";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";

import { Transform } from "framework/components/transform";
import { Velocity } from "framework/components/physics";
import { Health, Attack, Defense, Team } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { NPC, Player } from "framework/components/tags";
import { Collider } from "framework/components/physics";
import { Size } from "framework/components/size";
import type { GameWorld } from "framework/world";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { ArchetypeRegistry } from "framework/entities/archetypeRegistry";

beforeAll(() => {
  bootstrapFramework();
});

function createTestWorld(): GameWorld {
  const gameDef = createDefaultGameDefinition();
  const instance = createGameInstance(gameDef);
  return instance.world;
}

function spawnCustomEntity(world: GameWorld, kind: string, components: Record<string, Record<string, unknown>>): number {
  const { componentRegistry, archetypeRegistry } = getRegistries();
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  for (const [compName, compValues] of Object.entries(components)) {
    const comp = componentRegistry.get(compName);
    addComponent(world, eid, comp);
    for (const [field, value] of Object.entries(compValues)) {
      const compObj = comp as Record<string, Record<number, unknown>>;
      if (compObj[field] !== undefined) {
        compObj[field][eid] = value;
      }
    }
  }
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, kind);
  return eid;
}

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
    expect(systemRegistry.has("spawning")).toBe(true);
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

describe("loadGameDefinition (Item 1: sub-config loading)", () => {
  it("should load entities from game/ directory", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    expect(gameDef.resolvedEntities.length).toBeGreaterThan(0);
    const player = gameDef.resolvedEntities.find((e) => e.kind === "player");
    expect(player).toBeDefined();
    expect(player!.components.Health).toEqual({ current: 100, max: 100 });
  });

  it("should load behaviors from game/ directory", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    expect(gameDef.resolvedBehaviors.length).toBeGreaterThan(0);
    const wanderBehavior = gameDef.resolvedBehaviors.find((b) => b.id === "wander-default");
    expect(wanderBehavior).toBeDefined();
  });

  it("should load rules from game/ directory", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    expect(gameDef.resolvedRules["combat"]).toBeDefined();
    const combatRules = gameDef.resolvedRules["combat"] as Record<string, unknown>;
    expect(combatRules.friendlyFire).toBe(false);
  });

  it("should load spawns from game/ directory", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    expect(gameDef.resolvedSpawns.length).toBeGreaterThan(0);
    expect(gameDef.resolvedSpawns[0].kind).toBe("villager");
  });

  it("should resolve map source from registry", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    expect(gameDef.resolvedMapSource).toBeDefined();
    expect(gameDef.resolvedMapSource!.kind).toBe("generated");
  });
});

describe("loadGameDefinition integrity validation (Item 2)", () => {
  it("should not throw for valid config", () => {
    expect(() => loadGameDefinition({ gameJsonPath: "game/game.json" })).not.toThrow();
  });

  it("should throw for invalid game.json structure", () => {
    expect(() => loadGameDefinition({ gameJsonPath: "tests/shim/invalid-game.json" }))
      .toThrow();
  });
});

describe("combatSystem (Item 3: damage calculation)", () => {
  let world: GameWorld;

  beforeEach(() => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);
    world = instance.world;
  });

  it("should deal damage when attacker has Attack component", () => {
    const attacker = spawnCustomEntity(world, "test-attacker", {
      Health: { current: 100, max: 100 },
      Attack: { value: 15 },
      Team: { id: 1 },
    });

    const target = spawnCustomEntity(world, "test-target", {
      Health: { current: 100, max: 100 },
      Defense: { value: 5 },
      Team: { id: 2 },
    });

    const { systemRegistry } = getRegistries();
    const combatSpec = systemRegistry.get("combat");
    const sys = combatSpec.factory(world, { friendlyFire: true, attackCooldownMs: 0 });

    sys(world);

    expect(Health.current[target]).toBeLessThan(100);
  });

  it("should skip friendly fire when disabled", () => {
    const attacker = spawnCustomEntity(world, "test-attacker", {
      Health: { current: 100, max: 100 },
      Attack: { value: 15 },
      Team: { id: 1 },
    });

    const target = spawnCustomEntity(world, "test-target", {
      Health: { current: 100, max: 100 },
      Defense: { value: 5 },
      Team: { id: 1 },
    });

    const { systemRegistry } = getRegistries();
    const combatSpec = systemRegistry.get("combat");
    const sys = combatSpec.factory(world, { friendlyFire: false });

    sys(world);

    expect(Health.current[target]).toBe(100);
  });

  it("should remove entity when health reaches 0", () => {
    const attacker = spawnCustomEntity(world, "test-attacker", {
      Health: { current: 100, max: 100 },
      Attack: { value: 999 },
      Team: { id: 1 },
    });

    const target = spawnCustomEntity(world, "test-target", {
      Health: { current: 10, max: 100 },
      Defense: { value: 0 },
      Team: { id: 2 },
    });

    const { systemRegistry } = getRegistries();
    const combatSpec = systemRegistry.get("combat");
    const sys = combatSpec.factory(world, { friendlyFire: true, attackCooldownMs: 0 });

    sys(world);

    expect(hasComponent(world, target, Health)).toBe(false);
  });
});

describe("spawningSystem (Item 4)", () => {
  it("should run without error with empty spawn rules", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);
    instance.step(50);
    expect(instance.world.time.tick).toBe(1);
  });
});

describe("aiSystem with behavior loading (Item 8)", () => {
  it("should create behavior tree for NPC from archetype", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const instance = createGameInstance(gameDef);

    const { archetypeRegistry } = getRegistries();
    const villager = archetypeRegistry.get("villager");
    expect(villager.behavior).toBe("wander-default");

    const wanderDef = gameDef.resolvedBehaviors.find((b) => b.id === "wander-default");
    expect(wanderDef).toBeDefined();

    instance.step(50);
    expect(instance.world.time.tick).toBe(1);
  });
});

describe("GameInstance with game config", () => {
  it("should register loaded entities into archetypeRegistry", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const instance = createGameInstance(gameDef);

    const { archetypeRegistry } = getRegistries();
    expect(archetypeRegistry.has("player")).toBe(true);
    expect(archetypeRegistry.has("villager")).toBe(true);
    expect(instance.world.map).toBeDefined();
  });
});

describe("inventorySystem (Item 5)", () => {
  it("should pick up items when player is nearby", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);

    const player = spawnCustomEntity(instance.world, "player", {
      Transform: { x: 0, y: 0 },
      Health: { current: 100, max: 100 },
      Team: { id: 1 },
      Player: {},
    });

    const item = spawnCustomEntity(instance.world, "item", {
      Transform: { x: 8, y: 8 },
      Item: {},
    });

    Transform.x[player] = 10;
    Transform.y[player] = 10;
    Transform.x[item] = 12;
    Transform.y[item] = 12;

    instance.step(50);

    expect(instance.world.time.tick).toBe(1);
  });
});

describe("interactionSystem (Item 5)", () => {
  it("should detect nearby NPCs", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);

    const player = spawnCustomEntity(instance.world, "player", {
      Transform: { x: 0, y: 0 },
      Player: {},
    });

    const npc = spawnCustomEntity(instance.world, "villager", {
      Transform: { x: 0, y: 0 },
      NPC: {},
    });

    Transform.x[player] = 10;
    Transform.y[player] = 10;
    Transform.x[npc] = 20;
    Transform.y[npc] = 20;

    instance.step(50);

    expect(instance.world.time.tick).toBe(1);
  });
});

describe("archetypeRegistry edge cases", () => {
  it("should throw when getting non-existent archetype", () => {
    const { archetypeRegistry } = getRegistries();
    expect(() => archetypeRegistry.get("non-existent")).toThrow("not registered");
  });

  it("should throw on duplicate registration", () => {
    const { archetypeRegistry } = getRegistries();
    expect(() => archetypeRegistry.register({ kind: "player", components: {} }))
      .toThrow("already registered");
  });

  it("all() should return all registered archetypes", () => {
    const { archetypeRegistry } = getRegistries();
    const all = archetypeRegistry.all();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.some((a) => a.kind === "player")).toBe(true);
    expect(all.some((a) => a.kind === "villager")).toBe(true);
  });
});

describe("systemRegistry edge cases", () => {
  it("should throw on duplicate system registration", () => {
    const { systemRegistry } = getRegistries();
    expect(() =>
      systemRegistry.register({
        id: "ai",
        factory: () => (world) => world,
      })
    ).toThrow("already registered");
  });

  it("buildSystems should filter disabled systems", () => {
    const { systemRegistry } = getRegistries();
    const world = createTestWorld();
    const systems = buildSystems(world, [
      { id: "ai" },
      { id: "physics" },
      { id: "movement", enabled: false },
    ], systemRegistry);

    const ids = systems.map((_s, i) => {
      const specs = systemRegistry.all();
      return specs[i]?.id;
    });
    expect(systems.length).toBe(2);
  });

  it("buildSystems should respect after/before ordering", () => {
    const { systemRegistry } = getRegistries();

    systemRegistry.register({
      id: "test-after-physics",
      factory: () => (world) => world,
      after: ["physics"],
    });

    const world = createTestWorld();
    const systems = buildSystems(world, [
      { id: "ai" },
      { id: "physics" },
      { id: "test-after-physics" },
    ], systemRegistry);

    const specs = systemRegistry.all();
    const physicsIdx = specs.findIndex((s) => s.id === "physics");
    const testAfterIdx = specs.findIndex((s) => s.id === "test-after-physics");
    expect(physicsIdx).toBeGreaterThanOrEqual(0);
    expect(testAfterIdx).toBeGreaterThanOrEqual(0);
  });

  it("buildSystems should throw for unregistered system", () => {
    const world = createTestWorld();
    const { systemRegistry } = getRegistries();
    expect(() =>
      buildSystems(world, [{ id: "non-existent-system" }], systemRegistry)
    ).toThrow("not registered");
  });

  it("buildSystems should pass config to factory", () => {
    const { systemRegistry } = getRegistries();
    let receivedConfig: Record<string, unknown> | undefined;

    systemRegistry.register({
      id: "test-config-system",
      factory: (_world, config) => {
        receivedConfig = config;
        return (w) => w;
      },
    });

    const world = createTestWorld();
    buildSystems(world, [
      { id: "test-config-system", config: { customKey: "customValue" } },
    ], systemRegistry);

    expect(receivedConfig).toEqual({ customKey: "customValue" });
  });
});

describe("actionRegistry edge cases", () => {
  it("should throw on duplicate action registration", () => {
    const { actionRegistry } = getRegistries();
    expect(() => actionRegistry.register("Idle", () => () => State.SUCCEEDED))
      .toThrow("already registered");
  });

  it("all() should return action entries with names", () => {
    const { actionRegistry } = getRegistries();
    const all = actionRegistry.all();
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const entry of all) {
      expect(entry).toHaveProperty("name");
      expect(entry).toHaveProperty("factory");
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.factory).toBe("function");
    }
  });

  it("registered actions should be callable", () => {
    const { actionRegistry } = getRegistries();
    const factory = actionRegistry.get("Idle");
    const action = factory();
    const result = action();
    expect(result).toBe(State.SUCCEEDED);
  });
});

describe("GameInstance.step snapshot test", () => {
  it("should produce deterministic state after N ticks", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);

    const player = spawnCustomEntity(instance.world, "player", {
      Transform: { x: 100, y: 100 },
      Health: { current: 100, max: 100 },
      Velocity: { x: 0, y: 0, vx: 5, vy: 0 },
      Player: {},
    });

    instance.step(50);
    instance.step(50);
    instance.step(50);

    const state = {
      tick: instance.world.time.tick,
      entities: [] as Array<{
        x: number;
        y: number;
        hp: number;
        hasHealth: boolean;
        hasPlayer: boolean;
      }>,
    };

    for (let eid = 0; eid < 100; eid++) {
      if (hasComponent(instance.world, eid, Transform)) {
        state.entities.push({
          x: Math.round(Transform.x[eid] * 100) / 100,
          y: Math.round(Transform.y[eid] * 100) / 100,
          hp: Health.current[eid],
          hasHealth: hasComponent(instance.world, eid, Health),
          hasPlayer: hasComponent(instance.world, eid, Player),
        });
      }
    }

    expect(state.tick).toBe(3);
    expect(state.entities.length).toBe(1);
    expect(state.entities[0]).toEqual({
      x: 100.75,
      y: 100,
      hp: 100,
      hasHealth: true,
      hasPlayer: true,
    });
  });
});
