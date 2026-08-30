/**
 * 地图几何解析（framework/config/map.ts）。
 *
 * 从地图清单（game/maps/registry.json）按新管道配置构建运行时 MapGeometry：
 * - kind = "pipeline"：按 seed + 积木管道生成（积木注册表本模块自建并注册内置积木）；
 * - kind = "tiled"：path 指向的 Tiled JSON 已由 loadGameDefinition 在加载期内联，
 *   本模块同样内联后经 tiled-source 积木产出几何。
 *
 * 几何由固定 seed 确定性产出，按 key 缓存；被 /maps/runtime、/maps/meta
 * 调试端点消费（与仿真 world.maps 同源同内容）。
 */
import fs from "node:fs";
import { dirname, resolve } from "node:path";

import { createGeneratorRegistry, type GeneratorRegistry } from "map/generate/generatorRegistry";
import { registerBuiltinMapGenerators } from "map/generate/registerBuiltin";
import { buildMapGeometry } from "map/generate/pipeline";
import { MapRegistrySchema, type MapConfig } from "framework/config/schema/MapRegistrySchema";
import type { MapGeometry } from "map/geometry/types";

/** 地图清单路径（与 loadGameDefinition 的 game.json map.registry 默认值一致）。 */
const REGISTRY_PATH = "game/maps/registry.json";

/** 内置积木注册表（模块级惰性单例；积木为纯函数，多实例无状态差异）。 */
let blockRegistry: GeneratorRegistry | undefined;

function getBlockRegistry(): GeneratorRegistry {
  if (!blockRegistry) {
    blockRegistry = createGeneratorRegistry();
    registerBuiltinMapGenerators(blockRegistry);
  }
  return blockRegistry;
}

/** 读清单并解析为 MapConfig[]（Tiled 条目内联 JSON）。 */
function loadMapConfigs(): MapConfig[] {
  const raw: unknown = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
  const registry = MapRegistrySchema.parse(raw);
  const configs: MapConfig[] = [];
  for (const [key, entry] of Object.entries(registry.maps)) {
    if (entry.kind === "tiled") {
      const tiledJson: unknown = JSON.parse(
        fs.readFileSync(resolve(dirname(REGISTRY_PATH), entry.path), "utf-8"),
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
  return configs;
}

/** 列出配置中注册的全部地图 id（清单 maps 的键，按声明顺序）。 */
export function listMapIdsFromConfig(): string[] {
  return loadMapConfigs().map((config) => config.key);
}

/**
 * 从项目配置构建地图几何。
 *
 * @param mapId 指定地图 key；省略则取首个地图（与 world.defaultMapId 的
 *   game.json map.default 缺省序一致）
 * @returns MapGeometry；显式指定 key 且清单中不存在时返回 null
 */
export function getMapGeometryFromConfig(mapId?: string): MapGeometry | null {
  const configs = loadMapConfigs();
  const config = mapId === undefined ? configs[0] : configs.find((c) => c.key === mapId);
  if (!config) return null;
  return buildMapGeometry(config, getBlockRegistry());
}
