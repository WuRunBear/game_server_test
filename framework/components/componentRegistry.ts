/**
 * AoS 组件 archetype 初始化钩子。
 *
 * AoS 组件（如 Inventory、Needs、ResourceNode）是普通 JS 数组（`[] as T[]`），
 * 不是 bitecs SoA 组件：spawn 时不能走 `addComponent` + 按字段赋值的 SoA 路径。
 * 钩子负责按 archetype 的组件配置把初始结构写入 `ComponentAoS[eid]`。
 *
 * 类型名保持游戏无关——钩子只读 config 里给出的容量/数组等通用字段，
 * 不识别具体游戏语义（这些由 game/ 配置约定，钩子按字段名透传）。
 */
export type AosInitializer = (
  world: unknown,
  eid: number,
  config: unknown,
) => void;

export interface ComponentRegistry {
  /** 注册组件；同名重复注册抛错。 */
  register(name: string, component: unknown): void;
  /** 取组件；未注册抛错。 */
  get(name: string): unknown;
  /** 是否已注册。 */
  has(name: string): boolean;
  /** 全部已注册组件（name → 组件）。 */
  all(): Readonly<Record<string, unknown>>;
  /** 注册 AoS 组件的 archetype 初始化钩子。 */
  registerAosInitializer(name: string, initializer: AosInitializer): void;
  /** 取 AoS 组件钩子；未注册返回 undefined。 */
  getAosInitializer(name: string): AosInitializer | undefined;
  /** 是否为 AoS 组件（已注册且为 JS 数组）。 */
  isAosComponent(name: string): boolean;
}

/**
 * 创建组件注册表实例。
 *
 * 内部两张表按组件名并行索引：
 * - components：SoA/Tag 组件定义（bitecs defineComponent 的产物）
 * - aosInitializers：AoS 组件的 archetype 初始化钩子
 */
export function createComponentRegistry(): ComponentRegistry {
  const components = new Map<string, unknown>();
  const aosInitializers = new Map<string, AosInitializer>();

  return {
    register(name, component) {
      if (components.has(name)) {
        throw new Error(`Component "${name}" is already registered`);
      }
      components.set(name, component);
    },

    get(name) {
      const c = components.get(name);
      if (!c) {
        throw new Error(`Component "${name}" is not registered`);
      }
      return c;
    },

    has(name) {
      return components.has(name);
    },

    all() {
      return Object.fromEntries(components);
    },

    registerAosInitializer(name, initializer) {
      aosInitializers.set(name, initializer);
    },

    getAosInitializer(name) {
      return aosInitializers.get(name);
    },

    isAosComponent(name) {
      const c = components.get(name);
      // AoS 组件即普通 JS 数组；bitecs SoA 组件是 defineComponent 对象，非数组
      return Array.isArray(c);
    },
  };
}
