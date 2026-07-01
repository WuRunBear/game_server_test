export interface ComponentRegistry {
  register(name: string, component: unknown): void;
  get(name: string): unknown;
  has(name: string): boolean;
  all(): Readonly<Record<string, unknown>>;
}

export function createComponentRegistry(): ComponentRegistry {
  const components = new Map<string, unknown>();

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
  };
}
