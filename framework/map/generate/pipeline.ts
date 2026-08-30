/**
 * 生成管道执行器（framework/map/generate/pipeline.ts）。
 *
 * buildMapGeometry：把单张地图的生成配置（MapGenerationConfig）执行为
 * 不可变的 MapGeometry——
 * 1. 创建空 GeometryDraft；
 * 2. 按管道声明顺序执行各积木：每步从「总 seed + 步骤序号」派生独立
 *    随机流，并把该步骤的自有 params 切片透传给积木；
 * 3. 出口结构校验（validateMapGeometry）——硬错误抛出，软告警仅记日志；
 * 4. 冻结：draft 缓冲原样转为 MapGeometry 字段，并经 computeGeometryVersion
 *    计算内容指纹。
 *
 * 纯几何生产：不 import ECS/world，不产出实体；积木注册表经参数注入
 * （bootstrap 接线后由调用方传入）。
 */
import type { MapGeometry } from "map/geometry/types";
import { computeGeometryVersion } from "map/geometry/version";
import type { GeneratorRegistry } from "map/generate/generatorRegistry";
import { deriveStream } from "map/generate/rng";
import type { GenerationContext, GeometryDraft, MapGenerationConfig } from "map/generate/types";
import { createGeometryDraft } from "map/generate/types";
import { validateMapGeometry } from "map/generate/validate";

/**
 * 执行生成管道，产出冻结的 MapGeometry。
 *
 * @param config 地图生成配置（key + seed + 管道）
 * @param registry 生成积木注册表（管道中的 generator 名在此查找）
 * @returns 冻结的 MapGeometry（含内容指纹 version）
 * @throws Error 当管道引用未注册积木，或出口结构校验发现硬错误时
 *   （消息含地图 key 与具体原因）
 */
export function buildMapGeometry(config: MapGenerationConfig, registry: GeneratorRegistry): MapGeometry {
  const draft = createGeometryDraft(config.key);

  for (let index = 0; index < config.pipeline.length; index++) {
    const step = config.pipeline[index];
    if (!registry.has(step.generator)) {
      throw new Error(
        `map "${config.key}" pipeline step ${index}: generator "${step.generator}" is not registered`,
      );
    }
    const generator = registry.get(step.generator);
    const ctx: GenerationContext = {
      key: config.key,
      rng: deriveStream(config.seed, index),
      geometry: draft,
      params: step.params ?? {},
    };
    generator(ctx);
  }

  validateMapGeometry(draft);

  // 冻结：draft 仅存在于本函数内部，缓冲直接移交（零拷贝）；
  // regions Map 插入顺序即 regionOfTile 索引序，原样保留
  const grid = {
    width: draft.width,
    height: draft.height,
    tileWidth: draft.tileWidth,
    tileHeight: draft.tileHeight,
  };
  const geometry: MapGeometry = {
    key: draft.key,
    grid,
    tiles: draft.tiles,
    walkable: draft.walkable,
    regions: draft.regions,
    regionOfTile: draft.regionOfTile,
    version: "",
  };
  geometry.version = computeGeometryVersion(geometry);
  return geometry;
}
