/**
 * 地图生成器注册表（名 → 生成器工厂）。
 *
 * 与系统/组件注册表同模式的“名 → factory”注册表：生成器统一以
 * `generatorId → (opts) => MapRuntime` 的形式注册，供 buildMapRuntime
 * 按 id 查找并执行。注册表由 bootstrap 创建（幂等单例），
 * 地图配置（maps/registry.json）中的 generatorId 引用这里注册的名字。
 */
import type { MapRuntime } from "framework/map/types";

/** 地图生成器：接收任意参数对象（含 id / seed / width 等），返回运行时地图。 */
export type MapGenerator = (opts: Record<string, unknown>) => MapRuntime;

/** 注册表条目：生成器 id + 生成函数。 */
export interface GeneratorEntry {
  /** 生成器唯一 id（供配置引用）。 */
  id: string;
  /** 生成函数本身。 */
  generator: MapGenerator;
}

/** 地图生成器注册表接口（注册 / 查询 / 枚举）。 */
export interface GeneratorRegistry {
  /** 注册生成器；id 重复时抛错，避免静默覆盖。 */
  register(id: string, gen: MapGenerator): void;
  /** 按 id 获取生成器；未注册时抛错。 */
  get(id: string): MapGenerator;
  /** 判断指定 id 是否已注册。 */
  has(id: string): boolean;
  /** 列出全部条目（返回副本，外部修改不影响内部表）。 */
  all(): GeneratorEntry[];
}

/**
 * 创建生成器注册表实例（内部以 Map 存储）。
 *
 * @returns 注册表实例
 */
export function createGeneratorRegistry(): GeneratorRegistry {
  // 内部存储：generatorId → 生成函数
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
      return [...generators.entries()].map(([id, generator]) => ({ id, generator }));
    },
  };
}
