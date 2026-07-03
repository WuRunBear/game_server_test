import type { MapRuntime, MapSource } from "framework/map/types";
import { mapRuntimeFromTiled } from "framework/map/tiled";
import { getRegistries } from "framework/bootstrap";

export function buildMapRuntime(source: MapSource): MapRuntime {
  if (source.kind === "tiled") {
    return mapRuntimeFromTiled(source.id, source.name, source.json);
  }

  const { generatorRegistry } = getRegistries();
  const generator = generatorRegistry.get(source.generatorId);
  return generator(source as unknown as Record<string, unknown>);
}
