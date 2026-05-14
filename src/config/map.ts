import fs from "node:fs";

import type { MapSource } from "map";

function readJsonFile(filePath: string): unknown {
  const text = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(text) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function getNumber(entry: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const v = asNumber(entry[key]);
    if (v !== null) return v;
  }
  return fallback;
}

function getString(entry: Record<string, unknown>, key: string): string | null {
  return asString(entry[key]);
}

function mapSourceFromRegistryFile(
  registryPath: string,
  mapId: string | null,
): MapSource {
  const raw = readJsonFile(registryPath);
  if (!isRecord(raw)) throw new Error("地图清单格式错误：根节点必须是对象");

  const defaultId = asString(raw.default) ?? null;
  const mapsRaw = raw.maps;
  if (!isRecord(mapsRaw)) throw new Error("地图清单格式错误：maps 必须是对象（mapId -> 配置）");

  const availableIds = Object.keys(mapsRaw);
  const selectedId = mapId ?? defaultId ?? availableIds[0] ?? null;
  if (!selectedId) throw new Error("地图清单为空：至少需要一个 mapId");

  const entryRaw = mapsRaw[selectedId];
  if (!isRecord(entryRaw)) throw new Error(`地图清单格式错误：maps.${selectedId} 不是对象`);

  const kind = getString(entryRaw, "kind");
  const id = getString(entryRaw, "id") ?? selectedId;
  const name = getString(entryRaw, "name") ?? selectedId;

  if (kind === "tiled") {
    const path = getString(entryRaw, "path");
    if (!path) throw new Error(`地图清单缺少字段：maps.${selectedId}.path`);

    return {
      kind: "tiled",
      id,
      name,
      json: readJsonFile(path),
    };
  }

  if (kind === "generated") {
    return {
      kind: "generated",
      generatorId: "simple",
      id,
      name,
      seed: getNumber(entryRaw, ["seed"], 1),
      width: getNumber(entryRaw, ["width"], 64),
      height: getNumber(entryRaw, ["height"], 64),
      tileWidth: getNumber(entryRaw, ["tileWidth", "tileW"], 16),
      tileHeight: getNumber(entryRaw, ["tileHeight", "tileH"], 16),
    };
  }

  throw new Error(`地图清单 kind 不支持：maps.${selectedId}.kind=${String(kind)}`);
}

export function getMapSourceFromConfig(): MapSource {
  const registryPath = "config/maps.registry.json";
  return mapSourceFromRegistryFile(registryPath, null);
}
