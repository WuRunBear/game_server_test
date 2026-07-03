import type { GeneratorRegistry } from "framework/map/generatorRegistry";
import { generateSimpleMap } from "framework/map/generated/simple";

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
    }),
  );
}
