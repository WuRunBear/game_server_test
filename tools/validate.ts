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
    console.log(`  生成规则: ${gameDef.resolvedSpawns.length} 个`);
    console.log(`  地图: ${gameDef.resolvedMapSource ? gameDef.resolvedMapSource.id : "无"}`);
  } catch (err) {
    console.error("✗ 配置校验失败:");
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
