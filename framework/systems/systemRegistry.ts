import type { System, GameWorld } from "framework/world";

export interface SystemSpec {
  id: string;
  factory: (world: GameWorld, config?: Record<string, unknown>) => System;
  after?: string[];
  before?: string[];
  defaultOrder?: number;
}

export interface SystemRegistry {
  register(spec: SystemSpec): void;
  get(id: string): SystemSpec;
  has(id: string): boolean;
  all(): SystemSpec[];
}

export function createSystemRegistry(): SystemRegistry {
  const systems = new Map<string, SystemSpec>();

  return {
    register(spec) {
      if (systems.has(spec.id)) {
        throw new Error(`System "${spec.id}" is already registered`);
      }
      systems.set(spec.id, spec);
    },

    get(id) {
      const spec = systems.get(id);
      if (!spec) {
        throw new Error(`System "${id}" is not registered`);
      }
      return spec;
    },

    has(id) {
      return systems.has(id);
    },

    all() {
      return [...systems.values()];
    },
  };
}

interface SystemEnableEntry {
  id: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

function topologicalSort(specs: SystemSpec[]): SystemSpec[] {
  const graph = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const s of specs) {
    const deps: string[] = [];
    if (s.after) deps.push(...s.after);
    if (s.before) {
      for (const b of s.before) {
        if (specs.some((o) => o.id === b)) {
          deps.push(b);
        }
      }
    }
    graph.set(s.id, deps);
    inDegree.set(s.id, 0);
  }

  for (const [id, deps] of graph) {
    for (const dep of deps) {
      if (inDegree.has(dep)) {
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  const result: SystemSpec[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const spec = specs.find((s) => s.id === id)!;
    result.push(spec);

    for (const [otherId, deps] of graph) {
      if (deps.includes(id)) {
        const newDegree = (inDegree.get(otherId) ?? 1) - 1;
        inDegree.set(otherId, newDegree);
        if (newDegree === 0) queue.push(otherId);
      }
    }
  }

  return result;
}

export function buildSystems(
  world: GameWorld,
  enabled: SystemEnableEntry[],
  registry?: SystemRegistry,
): System[] {
  const reg = registry ?? (world.systems_registry as unknown as SystemRegistry);
  const enabledIds = new Set(
    enabled.filter((e) => e.enabled !== false).map((e) => e.id),
  );

  const specs: SystemSpec[] = [];
  const configs = new Map<string, Record<string, unknown>>();
  for (const entry of enabled) {
    if (!reg.has(entry.id)) {
      throw new Error(`System "${entry.id}" is not registered`);
    }
    const spec = reg.get(entry.id);
    if (enabledIds.has(spec.id)) {
      specs.push(spec);
      if (entry.config) {
        configs.set(spec.id, entry.config);
      }
    }
  }

  const ordered = topologicalSort(specs);
  return ordered.map((s) => s.factory(world, configs.get(s.id)));
}
