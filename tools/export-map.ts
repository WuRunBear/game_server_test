import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  bootstrapFramework,
  exportMapRuntime,
} from "framework";
import { buildMapGeometry } from "map/generate/pipeline";
import { createGeneratorRegistry } from "map/generate/generatorRegistry";
import { registerBuiltinMapGenerators } from "map/generate/registerBuiltin";
import { MapRegistrySchema, type MapConfig } from "framework/config/schema/MapRegistrySchema";
import type { MapGeometry } from "map/geometry/types";
import type { MapRuntime } from "framework/map/types";

/** MapGeometry → 旧导出器所需的 MapRuntime 视图（blocked 由 walkable 取反，区域/出生点不在旧模型中表达）。 */
function geometryToRuntimeView(geometry: MapGeometry): MapRuntime {
  const blocked = new Uint8Array(geometry.walkable.length);
  for (let i = 0; i < geometry.walkable.length; i++) {
    blocked[i] = geometry.walkable[i] === 0 ? 1 : 0;
  }
  return {
    id: geometry.key,
    name: geometry.key,
    grid: geometry.grid,
    blocked,
    spawns: { player: null, npcs: [] },
    zones: [],
  };
}

function buildConfigFromRegistry(configs: MapConfig[], mapId: string | null): MapConfig {
  const selectedId = mapId ?? configs[0]?.key;
  const config = selectedId ? configs.find((c) => c.key === selectedId) : undefined;
  if (!config) {
    const available = configs.map((c) => c.key).join(", ");
    throw new Error(`地图 "${selectedId}" 未在注册表中找到。可用: ${available}`);
  }
  return config;
}

export function exportMap(argv: string[]): void {
  const mapId = argv[0] || null;

  const args: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (argv[i]?.startsWith("--") && argv[i + 1] !== undefined) {
      args[argv[i].replace(/^--/, "")] = argv[i + 1];
    }
  }

  bootstrapFramework();

  try {
    const registryPath = resolve(process.cwd(), "game/maps/registry.json");
    if (!existsSync(registryPath)) {
      console.error(`地图注册表文件不存在: ${registryPath}`);
      process.exit(1);
    }

    const registry = MapRegistrySchema.parse(JSON.parse(readFileSync(registryPath, "utf8")));
    const configs: MapConfig[] = [];
    for (const [key, entry] of Object.entries(registry.maps)) {
      if (entry.kind === "tiled") {
        const tiledJson: unknown = JSON.parse(
          readFileSync(resolve(dirname(registryPath), entry.path), "utf8"),
        );
        configs.push({
          key,
          seed: 0,
          initialAgeTicks: entry.initialAgeTicks,
          pipeline: [{ generator: "tiled-source", params: { tiled: tiledJson } }],
        });
      } else {
        configs.push({ key, seed: entry.seed, initialAgeTicks: entry.initialAgeTicks, pipeline: entry.pipeline });
      }
    }

    const registryBlocks = createGeneratorRegistry();
    registerBuiltinMapGenerators(registryBlocks);
    const geometry = buildMapGeometry(buildConfigFromRegistry(configs, mapId), registryBlocks);
    const runtime = geometryToRuntimeView(geometry);
    const outDir = args.out ? resolve(process.cwd(), args.out) : undefined;
    const { jsonPath, pngPath } = exportMapRuntime(runtime, outDir);
    console.log(`地图已导出: ${jsonPath}, ${pngPath}`);
  } catch (err) {
    console.error("地图导出失败:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
