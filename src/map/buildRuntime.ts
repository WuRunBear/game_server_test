import type { MapRuntime, MapSource } from "map/types";
import { generateSimpleMap } from "map/generated/simple";
import { mapRuntimeFromTiled } from "map/tiled";

export function buildMapRuntime(source: MapSource): MapRuntime {
  if (source.kind === "tiled") {
    return mapRuntimeFromTiled(source.id, source.name, source.json);
  }

  return generateSimpleMap({
    id: source.id,
    name: source.name,
    seed: source.seed,
    width: source.width,
    height: source.height,
    tileWidth: source.tileWidth,
    tileHeight: source.tileHeight,
  });
}
