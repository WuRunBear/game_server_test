/**
 * 行为树节点工厂注册表（action / condition 统一注册）。
 *
 * 行为树配置里引用的节点名通过这里查表拿到"工厂函数"，
 * 工厂再根据配置参数（args）生成 mistreevous 的 agent 方法。
 * 框架侧只维护「名 → 工厂」的映射，具体注册哪些节点由注册层
 * （如 registerBuiltinActions）与游戏配置决定，与游戏内容解耦。
 */
import type { State } from "mistreevous";
import type { RegistrationMetadata } from "framework/registryMetadata";
import { assertStrictConfigSchema } from "framework/registryMetadata";

/**
 * 行为树节点工厂：返回 agent 方法。
 * 返回值兼容 mistreevous 的 `AgentFunction`（`ActionResult | boolean`）：
 * - action 节点返回 `State`（SUCCEEDED/FAILED/RUNNING）
 * - condition 节点返回 `boolean`
 */
export type ActionFactory = (args?: Record<string, unknown>) => () => State | boolean;

export interface ActionEntry extends RegistrationMetadata {
  name: string;
  factory: ActionFactory;
}

/**
 * 行为树节点注册表接口：以"节点名"为键的工厂查找表。
 * 约定：重名 register 与未注册 get 均由实现抛错，避免配置歧义。
 */
export interface ActionRegistry {
  register(name: string, factory: ActionFactory, meta?: RegistrationMetadata): void;
  get(name: string): ActionFactory;
  has(name: string): boolean;
  all(): ActionEntry[];
}

/**
 * 创建行为树节点注册表：内部以 Map 存储。
 * register 重名抛错（防止静默覆盖造成行为树配置歧义）；
 * get 未注册抛错（编译行为树时会因此提前暴露配置错误）。
 */
export function createActionRegistry(): ActionRegistry {
  const actions = new Map<string, ActionEntry>();

  return {
    register(name, factory, meta) {
      if (actions.has(name)) {
        throw new Error(`Action "${name}" is already registered`);
      }
      assertStrictConfigSchema(name, meta?.configSchema);
      actions.set(name, { name, factory, ...meta });
    },

    get(name) {
      const entry = actions.get(name);
      if (!entry) {
        throw new Error(`Action "${name}" is not registered`);
      }
      return entry.factory;
    },

    has(name) {
      return actions.has(name);
    },

    all() {
      return [...actions.values()];
    },
  };
}
