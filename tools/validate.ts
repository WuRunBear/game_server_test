import {
  bootstrapFramework,
  loadGameDefinition,
} from "framework";

export function validate(argv: string[]): void {
  const configPath = argv[0] ?? "game/game.json";

  bootstrapFramework();

  try {
    const gameDef = loadGameDefinition({ gameJsonPath: configPath });
    console.log("✓ 配置校验通过");
    console.log(`  游戏: ${gameDef.name ?? gameDef.id}`);
    console.log(`  tick rate: ${gameDef.tickRate} Hz`);
    console.log(`  实体原型: ${gameDef.resolvedEntities.length} 个`);
    console.log(`  行为树: ${gameDef.resolvedBehaviors.length} 个`);
    console.log(`  规则模块: ${Object.keys(gameDef.resolvedRules).length} 个`);
    console.log(`  item kind: ${gameDef.resolvedItems.length} 个`);
    const configs = gameDef.resolvedMapConfigs;
    const defaultMap = gameDef.map?.default ? ` (默认: ${gameDef.map.default})` : "";
    console.log(`  地图: ${configs.map((c) => c.key).join(", ") || "无"}${defaultMap}`);
    for (const config of configs) {
      console.log(`    ${config.key}: ${config.pipeline.map((step) => step.generator).join(" → ")}`);
    }
    console.log(`  实体演化规则: ${gameDef.resolvedEntityRules.length} 条`);
    const spawn = gameDef.resolvedPlayerRule?.spawn;
    const spawnDesc = spawn
      ? `${spawn.mode}${spawn.region ? ` (region: ${spawn.region})` : ""}`
      : "未配置";
    console.log(`  玩家出生规则: ${spawnDesc}`);
  } catch (err) {
    console.error("✗ 配置校验失败:");
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
