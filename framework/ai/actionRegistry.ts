import type { State } from "mistreevous";

export type ActionFactory = (args?: Record<string, unknown>) => () => State;

export interface ActionEntry {
  name: string;
  factory: ActionFactory;
}

export interface ActionRegistry {
  register(name: string, factory: ActionFactory): void;
  get(name: string): ActionFactory;
  has(name: string): boolean;
  all(): ActionEntry[];
}

export function createActionRegistry(): ActionRegistry {
  const actions = new Map<string, ActionFactory>();

  return {
    register(name, factory) {
      if (actions.has(name)) {
        throw new Error(`Action "${name}" is already registered`);
      }
      actions.set(name, factory);
    },

    get(name) {
      const factory = actions.get(name);
      if (!factory) {
        throw new Error(`Action "${name}" is not registered`);
      }
      return factory;
    },

    has(name) {
      return actions.has(name);
    },

    all() {
      return [...actions.entries()].map(([name, factory]) => ({ name, factory }));
    },
  };
}
