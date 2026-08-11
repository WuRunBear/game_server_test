import fs from "node:fs";

import type { MapSource } from "map";

/**
 * 地图来源解析（framework/config/map.ts）。
 *
 * 从地图清单（game/maps/registry.json）解析出运行时可用的 MapSource：
 * - kind = "tiled"：读取外部 Tiled JSON 瓦片地图文件，内容内联进 MapSource.json
 * - kind = "generated"：声明生成器（generatorId）与种子/尺寸，由地图生成器程序化产出
 *
 * 与 schema/MapRegistrySchema.ts（纯配置校验）不同，本文件面向地图运行时
 * （framework/map），采用手工解析而非 zod；被 bootstrapFramework 用于装配世界地图。
 */

/**
 * 读取并解析 JSON 文件。
 *
 * @param filePath 文件路径
 * @returns 解析后的 JSON 值
 * @throws Error 当文件读取失败或 JSON 解析失败时抛出
 */
function readJsonFile(filePath: string): unknown {
  const text = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(text) as unknown;
}

/**
 * 判断值是否为普通对象（Record）。
 *
 * @param value 任意值
 * @returns 是否为对象且非数组
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把 unknown 转为 number（有限数）或返回 null。
 *
 * @param value 任意值
 * @returns number 或 null
 */
function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 把 unknown 转为 string 或返回 null。
 *
 * @param value 任意值
 * @returns string 或 null
 */
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * 从配置对象中按候选键读取 number，找不到则返回默认值。
 *
 * @param entry 配置对象
 * @param keys 候选键列表（按优先级顺序）
 * @param fallback 默认值
 * @returns 读取到的 number
 */
function getNumber(entry: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const v = asNumber(entry[key]);
    if (v !== null) return v;
  }
  return fallback;
}

/**
 * 从配置对象读取 string 字段。
 *
 * @param entry 配置对象
 * @param key 字段名
 * @returns string 或 null
 */
function getString(entry: Record<string, unknown>, key: string): string | null {
  return asString(entry[key]);
}

/**
 * 从地图清单文件中解析出 MapSource。
 *
 * @param registryPath 地图清单路径
 * @param mapId 指定 mapId；为 null 则按 default/第一个可用 mapId 选择
 * @returns MapSource
 * @throws Error 当清单格式错误或无法选择地图时抛出
 */
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
      generatorId: asString(entryRaw.generatorId) ?? "simple",
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

/**
 * 从项目配置读取地图来源（MapSource）。
 *
 * @returns MapSource
 * @throws Error 当地图清单读取或解析失败时抛出
 */
export function getMapSourceFromConfig(): MapSource {
  const registryPath = "game/maps/registry.json";
  return mapSourceFromRegistryFile(registryPath, null);
}
