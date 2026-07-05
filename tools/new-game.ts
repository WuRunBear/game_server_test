import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";

interface NewGameOptions {
  id: string;
  name: string;
  tickRate: number;
  outDir: string;
}

function parseArgs(argv: string[]): NewGameOptions {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]?.startsWith("--") && argv[i + 1] !== undefined) {
      args[argv[i].replace(/^--/, "")] = argv[i + 1];
    } else if (i === 0 && !argv[i]?.startsWith("--")) {
      args.id = argv[i];
    }
  }

  return {
    id: args.id ?? "new-game",
    name: args.name ?? args.id ?? "New Game",
    tickRate: Number(args["tick-rate"]) || 20,
    outDir: args.out ?? "game",
  };
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function newGame(argv: string[]): void {
  const opts = parseArgs(argv);
  const baseDir = resolve(process.cwd(), opts.outDir);

  if (existsSync(join(baseDir, "game.json"))) {
    console.error(`错误: ${opts.outDir}/game.json 已存在。请指定其他输出目录或手动删除后重试。`);
    process.exit(1);
  }

  const dirs = [
    baseDir,
    join(baseDir, "entities"),
    join(baseDir, "behaviors"),
    join(baseDir, "rules"),
    join(baseDir, "spawns"),
    join(baseDir, "maps"),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  writeJson(join(baseDir, "game.json"), {
    id: opts.id,
    name: opts.name,
    tickRate: opts.tickRate,
    map: { registry: "./maps/registry.json", default: `${opts.id}-map` },
    systems: [
      { id: "ai" },
      { id: "physics" },
      { id: "movement" },
      { id: "collision" },
      { id: "combat", config: { friendlyFire: false } },
      { id: "spawning" },
      { id: "inventory" },
      { id: "interaction" },
    ],
    entities: "./entities/*.json",
    behaviors: "./behaviors/*.json",
    rules: "./rules/*.json",
    spawns: "./spawns/*.json",
    netSync: {
      fields: [
        { component: "Transform", fields: ["x", "y"] },
        { component: "Health", fields: ["current"] },
        { component: "Collider", fields: ["shape", "radius"] },
        { component: "Size", fields: ["w", "h"] },
      ],
    },
  });

  writeJson(join(baseDir, "maps", "registry.json"), {
    default: `${opts.id}-map`,
    maps: {
      [`${opts.id}-map`]: {
        kind: "generated",
        generatorId: "simple",
        name: opts.name,
        seed: 1,
        width: 64,
        height: 64,
        tileWidth: 16,
        tileHeight: 16,
      },
    },
  });

  console.log(`✓ 游戏脚手架已创建: ${baseDir}`);
  console.log("  接下来可以:");
  console.log(`    - 编辑 ${opts.outDir}/game.json 调整系统配置`);
  console.log(`    - 在 ${opts.outDir}/entities/ 中添加实体原型`);
  console.log(`    - 运行 pnpm tools validate 校验配置`);
}
