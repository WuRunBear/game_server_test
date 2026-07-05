import type { MapRuntime } from "framework/map/types";

export type MapGenerator = (opts: Record<string, unknown>) => MapRuntime;

export interface GeneratorRegistry {
  register(id: string, gen: MapGenerator): void;
  get(id: string): MapGenerator;
  has(id: string): boolean;
  all(): MapGenerator[];
}

export function createGeneratorRegistry(): GeneratorRegistry {
  const generators = new Map<string, MapGenerator>();

  return {
    register(id, gen) {
      if (generators.has(id)) {
        throw new Error(`Generator "${id}" is already registered`);
      }
      generators.set(id, gen);
    },

    get(id) {
      const gen = generators.get(id);
      if (!gen) {
        throw new Error(`Generator "${id}" is not registered`);
      }
      return gen;
    },

    has(id) {
      return generators.has(id);
    },

    all() {
      return [...generators.values()];
    },
  };
}
