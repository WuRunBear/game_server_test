/**
 * 生成层模块 barrel（framework/map/generate/index.ts）。
 *
 * 公共面：类型（GeometryDraft / GenerationContext / MapGenerator /
 * MapGenerationConfig）、随机流（createRng / deriveStream）、管道执行器
 * （buildMapGeometry）、出口校验（validateMapGeometry）、积木注册表
 * （createGeneratorRegistry）。
 */
export type {
  GenerationContext,
  GeometryDraft,
  MapGenerationConfig,
  MapGenerationStep,
  MapGenerator,
} from "./types";
export { createGeometryDraft } from "./types";

export type { Rng } from "./rng";
export { createRng, deriveStream } from "./rng";

export { buildMapGeometry } from "./pipeline";

export { validateMapGeometry } from "./validate";
export type { GeometryValidationInput } from "./validate";

export type { GeneratorEntry, GeneratorRegistry } from "./generatorRegistry";
export { createGeneratorRegistry } from "./generatorRegistry";
