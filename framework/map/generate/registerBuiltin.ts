/**
 * 内置生成积木注册：把框架自带的生成积木挂到生成积木注册表上。
 *
 * 每个积木对应一个注册名（如 "noise-terrain"），由地图生成配置
 * （MapGenerationConfig.pipeline[].generator）引用。注册表实例由
 * bootstrap 创建后传入（接线属后续核心切换 todo）。
 */
import type { GeneratorRegistry } from "map/generate/generatorRegistry";
import { caCave } from "map/generate/blocks/caCave";
import { climateRegions } from "map/generate/blocks/climateRegions";
import { heightChannel } from "map/generate/blocks/heightChannel";
import { heightMask } from "map/generate/blocks/heightMask";
import { noiseChannel } from "map/generate/blocks/noiseChannel";
import { noiseTerrain } from "map/generate/blocks/noiseTerrain";
import { quantizeTerrain } from "map/generate/blocks/quantizeTerrain";
import { regionStats } from "map/generate/blocks/regionStats";
import { river } from "map/generate/blocks/river";
import { roomCorridor } from "map/generate/blocks/roomCorridor";
import { slotRooms } from "map/generate/blocks/slotRooms";
import { stampTemplate } from "map/generate/blocks/stampTemplate";
import { smoothTerrain } from "map/generate/blocks/smoothTerrain";
import { tiledSource } from "map/generate/blocks/tiledSource";
import { whittakerRegions } from "map/generate/blocks/whittakerRegions";

/**
 * 注册全部内置生成积木（"noise-terrain" / "climate-regions" /
 * "room-corridor" / "tiled-source" / "region-stats" / "smooth-terrain" /
 * "height-channel" / "height-mask" / "quantize-terrain" / "slot-rooms" /
 * "stamp-template" / "noise-channel" / "whittaker-regions" / "river" /
 * "ca-cave"）。
 *
 * @param registry 生成积木注册表（由 bootstrap 创建后传入）
 */
export function registerBuiltinMapGenerators(registry: GeneratorRegistry): void {
  registry.register("noise-terrain", noiseTerrain);
  registry.register("climate-regions", climateRegions);
  registry.register("room-corridor", roomCorridor);
  registry.register("tiled-source", tiledSource);
  registry.register("region-stats", regionStats);
  registry.register("smooth-terrain", smoothTerrain);
  registry.register("height-channel", heightChannel);
  registry.register("height-mask", heightMask);
  registry.register("quantize-terrain", quantizeTerrain);
  registry.register("slot-rooms", slotRooms);
  registry.register("stamp-template", stampTemplate);
  registry.register("noise-channel", noiseChannel);
  registry.register("whittaker-regions", whittakerRegions);
  registry.register("river", river);
  registry.register("ca-cave", caCave);
}
