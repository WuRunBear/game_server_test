export interface ArchetypeSpec {
  kind: string;
  tags?: string[];
  /** 组件配置值可为对象（SoA 字段）或数组等任意结构（AoS 组件）。 */
  components: Record<string, unknown>;
  behavior?: string;
  team?: number;
}

export interface ArchetypeRegistry {
  register(spec: ArchetypeSpec): void;
  /** 覆盖注册：同 kind 已存在时替换（game 配置优先于框架内建原型）。 */
  override(spec: ArchetypeSpec): void;
  get(kind: string): ArchetypeSpec;
  has(kind: string): boolean;
  all(): ArchetypeSpec[];
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

    override(spec) {
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

    all() {
      return [...archetypes.values()];
    },
  };
}
