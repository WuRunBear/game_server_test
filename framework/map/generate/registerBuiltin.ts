/**
 * 内置生成积木注册：把框架自带的生成积木挂到生成积木注册表上。
 *
 * 每个积木对应一个注册名（如 "noise-terrain"），由地图生成配置
 * （MapGenerationConfig.pipeline[].generator）引用。注册表实例由
 * bootstrap 创建后传入（接线属后续核心切换 todo）。
 */
import type { GeneratorRegistry } from "map/generate/generatorRegistry";
import { climateRegions } from "map/generate/blocks/climateRegions";
import { noiseTerrain } from "map/generate/blocks/noiseTerrain";
import { roomCorridor } from "map/generate/blocks/roomCorridor";
import { tiledSource } from "map/generate/blocks/tiledSource";

/**
 * 注册全部内置生成积木（"noise-terrain" / "climate-regions" /
 * "room-corridor" / "tiled-source"）。
 *
 * @param registry 生成积木注册表（由 bootstrap 创建后传入）
 */
export function registerBuiltinMapGenerators(registry: GeneratorRegistry): void {
  registry.register("noise-terrain", noiseTerrain);
  registry.register("climate-regions", climateRegions);
  registry.register("room-corridor", roomCorridor);
  registry.register("tiled-source", tiledSource);
}
