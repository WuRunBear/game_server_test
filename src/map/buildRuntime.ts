import type { MapRuntime, MapSource } from "map/types";
import { exportGeneratedMapArtifacts } from "map/exportGenerated";
import { generateSimpleMap } from "map/generated/simple";
import { mapRuntimeFromTiled } from "map/tiled";

/**
 * 根据地图来源构建运行时地图数据。
 *
 * @param source 地图来源（tiled 或 generated）
 * @returns MapRuntime
 */
export function buildMapRuntime(source: MapSource): MapRuntime {
  if (source.kind === "tiled") {
    return mapRuntimeFromTiled(source.id, source.name, source.json);
  }

  const runtime = generateSimpleMap({
    id: source.id,
    name: source.name,
    seed: source.seed,
    width: source.width,
    height: source.height,
    tileWidth: source.tileWidth,
    tileHeight: source.tileHeight,
  });

  exportGeneratedMapArtifacts(runtime);

  return runtime;
}
