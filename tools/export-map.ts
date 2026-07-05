import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import {
  bootstrapFramework,
  loadGameDefinition,
  buildMapRuntime,
  exportMapRuntime,
} from "framework";
import type { MapSource } from "framework/map/types";
import type { MapRegistryJson, GeneratedMapEntryJson, TiledMapEntryJson } from "framework/config/schema/MapRegistrySchema";

function buildSourceFromRegistry(registry: MapRegistryJson, mapId: string | null): MapSource {
  const entries = registry.maps;
  const defaultId = registry.default ?? Object.keys(entries)[0];
  const selectedId = mapId ?? defaultId;
  if (!selectedId || !entries[selectedId]) {
    const available = Object.keys(entries).join(", ");
    throw new Error(`地图 "${selectedId}" 未在注册表中找到。可用: ${available}`);
  }

  const entry = entries[selectedId];
  if (entry.kind === "tiled") {
    const tiledEntry = entry as TiledMapEntryJson;
    return {
      kind: "tiled",
      id: tiledEntry.id ?? selectedId,
      name: tiledEntry.name ?? selectedId,
      json: JSON.parse(readFileSync(tiledEntry.path, "utf8")),
    };
  }

  const genEntry = entry as GeneratedMapEntryJson;
  return {
    kind: "generated",
    generatorId: genEntry.generatorId ?? "simple",
    id: genEntry.id ?? selectedId,
    name: genEntry.name ?? selectedId,
    seed: genEntry.seed ?? 1,
    width: genEntry.width ?? 64,
    height: genEntry.height ?? 64,
    tileWidth: genEntry.tileWidth ?? 16,
    tileHeight: genEntry.tileHeight ?? 16,
  };
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
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });

    if (!gameDef.map?.registry) {
      console.error("当前 game.json 未配置地图注册表");
      process.exit(1);
    }

    const registryPath = resolve(dirname(resolve(process.cwd(), "game/game.json")), gameDef.map.registry);
    if (!existsSync(registryPath)) {
      console.error(`地图注册表文件不存在: ${registryPath}`);
      process.exit(1);
    }

    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as MapRegistryJson;
    const source = buildSourceFromRegistry(registry, mapId);
    const runtime = buildMapRuntime(source);
    const outDir = args.out ? resolve(process.cwd(), args.out) : undefined;
    const { jsonPath, pngPath } = exportMapRuntime(runtime, outDir);
    console.log(`地图已导出: ${jsonPath}, ${pngPath}`);
  } catch (err) {
    console.error("地图导出失败:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
