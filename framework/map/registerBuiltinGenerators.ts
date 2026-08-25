/**
 * 内置地图生成器注册：把框架自带的生成算法挂到生成器注册表上。
 *
 * 每个生成器对应一个 generatorId（如 "simple"），
 * 由地图配置（maps/registry.json 的 generatorId）引用。
 */
import type { GeneratorRegistry } from "framework/map/generatorRegistry";
import { generateSimpleMap } from "framework/map/generated/simple";
import { generateCaveMap } from "framework/map/generated/cave";

/**
 * 注册全部内置生成器（"simple" 与 "cave"）。
 *
 * @param registry 生成器注册表（由 bootstrap 创建后传入）
 */
export function registerBuiltinGenerators(registry: GeneratorRegistry): void {
  registry.register("simple", (opts: Record<string, unknown>) =>
    generateSimpleMap({
      id: opts.id as string,
      name: (opts.name as string) ?? "generated",
      seed: opts.seed as number,
      width: opts.width as number,
      height: opts.height as number,
      tileWidth: opts.tileWidth as number,
      tileHeight: opts.tileHeight as number,
      npcSpawns: opts.npcSpawns as
        | Array<{ kind: string; offsetTiles: [number, number]; zoneId?: number }>
        | undefined,
    }),
  );

  registry.register("cave", (opts: Record<string, unknown>) =>
    generateCaveMap({
      id: opts.id as string,
      name: (opts.name as string) ?? "generated",
      seed: opts.seed as number,
      width: opts.width as number,
      height: opts.height as number,
      tileWidth: opts.tileWidth as number,
      tileHeight: opts.tileHeight as number,
      npcSpawns: opts.npcSpawns as
        | Array<{ kind: string; offsetTiles: [number, number]; zoneId?: number }>
        | undefined,
    }),
  );
}
