import { resolve } from "node:path";
import {
  bootstrapFramework,
  loadGameDefinition,
  buildMapRuntime,
  exportMapRuntime,
} from "framework";

export function exportMap(argv: string[]): void {
  const mapId = argv[0];

  const args: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (argv[i]?.startsWith("--") && argv[i + 1] !== undefined) {
      args[argv[i].replace(/^--/, "")] = argv[i + 1];
    }
  }

  bootstrapFramework();

  try {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });

    if (!gameDef.resolvedMapSource) {
      console.error("当前 game.json 未配置地图源");
      process.exit(1);
    }

    const runtime = buildMapRuntime(gameDef.resolvedMapSource);
    const outDir = args.out ? resolve(process.cwd(), args.out) : undefined;
    const { jsonPath, pngPath } = exportMapRuntime(runtime, outDir);
    console.log(`地图已导出: ${jsonPath}, ${pngPath}`);
  } catch (err) {
    console.error("地图导出失败:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
