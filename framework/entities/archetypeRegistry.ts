export interface ArchetypeSpec {
  kind: string;
  tags?: string[];
  components: Record<string, Record<string, unknown>>;
  behavior?: string;
  team?: number;
}

export interface ArchetypeRegistry {
  register(spec: ArchetypeSpec): void;
  get(kind: string): ArchetypeSpec;
  has(kind: string): boolean;
}

export function createArchetypeRegistry(): ArchetypeRegistry {
  const archetypes = new Map<string, ArchetypeSpec>();

  return {
    register(spec) {
      if (archetypes.has(spec.kind)) {
        throw new Error(`Archetype "${spec.kind}" is already registered`);
      }
      archetypes.set(spec.kind, spec);
    },

    get(kind) {
      const spec = archetypes.get(kind);
      if (!spec) {
        throw new Error(`Archetype "${kind}" is not registered`);
      }
      return spec;
    },

    has(kind) {
      return archetypes.has(kind);
    },
  };
}
