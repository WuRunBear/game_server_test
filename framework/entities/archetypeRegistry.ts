/**
 * 原型注册表——「原型名（kind）→ 组件规格（ArchetypeSpec）」的工厂表。
 *
 * 原型（Archetype）是实体生成的蓝图：声明 kind 名称、各组件初始值、
 * 标签、AI 行为与阵营。spawnEntity 按原型生成实体；
 * AI/行为系统按 kind 路由实体（spawn 时经 setEntityKind 写入 Kind 组件）。
 *
 * 注册表为 bootstrapFramework 创建的单例；game/entities/*.json 的原型
 * 经 loadGameDefinition 加载后，用 override 覆盖同 kind 内建原型
 * （game 配置优先于框架内建兜底）。
 */
export interface ArchetypeSpec {
  /** 原型唯一名（kind），实体的 Kind 组件值，AI/行为按它路由。 */
  kind: string;
  /** 标签组件名列表（如 "Player"/"Item"），spawn 时按 TAG_MAP 挂载到实体。 */
  tags?: string[];
  /** 组件配置值可为对象（SoA 字段）或数组等任意结构（AoS 组件）。 */
  components: Record<string, unknown>;
  /** 行为树 id（无则实体不挂 AI 状态，静止不动）。 */
  behavior?: string;
  /** 阵营 id（战斗系统按它区分敌我；无则不挂 Team 组件）。 */
  team?: number;
}

export interface ArchetypeRegistry {
  /** 注册新原型；同 kind 已存在则抛错（尽早暴露配置重复）。 */
  register(spec: ArchetypeSpec): void;
  /** 覆盖注册：同 kind 已存在时替换（game 配置优先于框架内建原型）。 */
  override(spec: ArchetypeSpec): void;
  /** 按 kind 取原型；未注册则抛错（尽早暴露配置拼写错误）。 */
  get(kind: string): ArchetypeSpec;
  /** kind 是否已注册。 */
  has(kind: string): boolean;
  /** 返回全部已注册原型（副本数组）。 */
  all(): ArchetypeSpec[];
}

/**
 * 创建原型注册表：内部用 Map 存「kind → spec」。
 * register/get 双守卫（重复注册抛错、未注册访问抛错）用于快速定位配置错误。
 */
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
