import {
  bootstrapFramework,
  loadGameDefinition,
} from "framework";
import { validatePresentation } from "framework/content/presentation";

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
    const presentation = gameDef.resolvedPresentation;
    if (presentation) {
      // 语义完整性：每图有表现条目 + 被引用的 tile id 都有定义（纯函数，不抛）
      const report = validatePresentation(gameDef);
      if (!report.ok) {
        throw new Error(`表现语义校验失败:\n  ${report.errors.join("\n  ")}`);
      }
      const globalCount = Object.keys(presentation.tileSemantics).length;
      console.log(
        `  表现语义: ${Object.keys(presentation.maps).length} 图, 全局 tile 语义 ${globalCount} 个（完整性校验通过）`,
      );
    } else {
      console.log("  表现语义: 未配置（跳过）");
    }
    console.log(
      `  实体演化规则（配置）: ${gameDef.resolvedEntityRules.length} 条（运行时另按 game/ecosystems.json 展开追加）`,
    );
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
