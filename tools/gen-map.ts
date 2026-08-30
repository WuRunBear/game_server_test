import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bootstrapFramework,
  buildMapGeometry,
  getRegistries,
  loadGameDefinition,
  serializeGeometry,
} from "framework";

export function genMap(argv: string[]): void {
  const mapKey = argv[0];
  if (!mapKey) {
    console.error("用法: pnpm tools gen-map <mapKey> [--out <dir>]");
    process.exit(1);
  }

  const args: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (argv[i]?.startsWith("--") && argv[i + 1] !== undefined) {
      args[argv[i].replace(/^--/, "")] = argv[i + 1];
    }
  }

  bootstrapFramework();

  try {
    const gameDef = loadGameDefinition();
    const configs = gameDef.resolvedMapConfigs;
    const config = configs.find((c) => c.key === mapKey);
    if (!config) {
      const available = configs.map((c) => c.key).join(", ") || "无";
      throw new Error(`地图 "${mapKey}" 未在配置中找到。可用: ${available}`);
    }

    const geometry = buildMapGeometry(config, getRegistries().mapGeneratorRegistry);
    const snapshot = serializeGeometry(geometry);

    const outDir = resolve(process.cwd(), args.out ?? "out");
    mkdirSync(outDir, { recursive: true });
    const jsonPath = resolve(outDir, `${geometry.key}.json`);
    writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), "utf8");

    console.log(`地图几何快照已导出: ${jsonPath}`);
    console.log(`  version: ${geometry.version}, grid: ${geometry.grid.width}x${geometry.grid.height}, regions: ${[...geometry.regions.keys()].join(", ")}`);
  } catch (err) {
    console.error("地图生成失败:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
