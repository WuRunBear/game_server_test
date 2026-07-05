import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bootstrapFramework,
  buildMapRuntime,
  exportMapRuntime,
} from "framework";
import type { GeneratedMapSource } from "framework/map/types";

export function genMap(argv: string[]): void {
  const generatorId = argv[0];
  if (!generatorId) {
    console.error("用法: pnpm tools gen-map <generatorId> [--seed <n>] [--width <n>] [--height <n>] [--out <dir>]");
    process.exit(1);
  }

  const args: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (argv[i]?.startsWith("--") && argv[i + 1] !== undefined) {
      args[argv[i].replace(/^--/, "")] = argv[i + 1];
    }
  }

  bootstrapFramework();

  const source: GeneratedMapSource = {
    kind: "generated",
    generatorId,
    id: generatorId,
    name: generatorId,
    seed: Number(args.seed) || 1,
    width: Number(args.width) || 64,
    height: Number(args.height) || 64,
    tileWidth: 16,
    tileHeight: 16,
  };

  try {
    const runtime = buildMapRuntime(source);

    if (args.out) {
      const outDir = resolve(process.cwd(), args.out);
      mkdirSync(outDir, { recursive: true });
      const { jsonPath, pngPath } = exportMapRuntime(runtime, outDir);
      console.log(`地图已导出: ${jsonPath}, ${pngPath}`);
    } else {
      const { jsonPath, pngPath } = exportMapRuntime(runtime);
      console.log(`地图已导出: ${jsonPath}, ${pngPath}`);
    }
  } catch (err) {
    console.error("地图生成失败:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
