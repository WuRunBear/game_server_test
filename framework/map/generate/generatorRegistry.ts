/**
 * 生成积木注册表（名 → 积木函数）（framework/map/generate/generatorRegistry.ts）。
 *
 * 同款 register/get/has/all 形状，MapGenerator 签名为生成层管道约定
 * (ctx: GenerationContext) => void。注册表实例由 bootstrap 创建，
 * 地图配置管道中的 generator 名引用这里注册的名字。
 */
import type { MapGenerator } from "map/generate/types";

/** 注册表条目：积木 id + 积木函数。 */
export interface GeneratorEntry {
  /** 积木唯一 id（供配置管道引用）。 */
  id: string;
  /** 积木函数本身。 */
  generator: MapGenerator;
}

/** 生成积木注册表接口（注册 / 查询 / 枚举）。 */
export interface GeneratorRegistry {
  /** 注册积木；id 重复时抛错，避免静默覆盖。 */
  register(id: string, gen: MapGenerator): void;
  /** 按 id 获取积木；未注册时抛错。 */
  get(id: string): MapGenerator;
  /** 判断指定 id 是否已注册。 */
  has(id: string): boolean;
  /** 列出全部条目（返回副本，外部修改不影响内部表）。 */
  all(): GeneratorEntry[];
}

/**
 * 创建生成积木注册表实例（内部以 Map 存储）。
 *
 * @returns 注册表实例
 */
export function createGeneratorRegistry(): GeneratorRegistry {
  // 内部存储：积木 id → 积木函数
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
