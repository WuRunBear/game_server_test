/**
 * 派生地面视图（framework/simulation/worldClock/effectiveGround）——游戏无关。
 *
 * `effectiveGround = f(底板语义, 相位/进度, 层号, 区域, 格坐标 hash)`：
 * - **纯函数**：同 tick + 同坐标恒同值（无缓存、无累积状态），在线与离线一致；
 * - **不落盘、不改底板**：MapGeometry.tiles 恒定不变，派生值只在查询期存在；
 * - **配置驱动**：映射表来自 game/rules/environment.json 的 `groundOverrides`，
 *   框架只把语义 id 当不透明数字、相位 id 当不透明字符串透传；
 * - 斑驳覆盖：`coverage` 阈值 + `hash(seed, phaseId, x, y)`，相位切换不会逐
 *   tick 闪烁，同一相位每年覆盖同一批格子；
 * - 雪线：层号窗口（minLevel/maxLevel）与进度窗口（minProgress/maxProgress）
 *   组合表达「高海拔先积雪 / 低海拔先融化」。
 *
 * 客户端渲染可自行消费同一配置；服务端玩法（采集/温度/足迹等）经
 * `effectiveGroundAt` / `effectiveGroundViewAt` 取有效语义。
 */
import type { GameWorld } from "framework/world";
import type { EnvironmentRule, GroundOverride } from "framework/config/schema/RuleSchema";
import { levelAt, regionOf, tileAt } from "framework/map/geometry/query";
import type { MapGeometry } from "framework/map/geometry/types";
import { mixSeed } from "framework/simulation/rng";
import { getEnvironmentRule, phaseAt } from "framework/simulation/worldClock";

/** 派生查询的格上下文（tile 坐标 + 底板语义 + 层号 + 区域）。 */
export interface GroundQuery {
  /** tile 列坐标（整数）。 */
  x: number;
  /** tile 行坐标（整数）。 */
  y: number;
  /** 底板语义（MapGeometry.tiles 原值）。 */
  baseSemantic: number;
  /** 该格层号（MapGeometry.level）。 */
  level: number;
  /** 该格区域名（MapGeometry.regionOfTile → regions 键）；未知为 undefined。 */
  region?: string;
}

/** 派生结果（含诊断字段；玩法通常只读 semantic）。 */
export interface EffectiveGroundView {
  /** 有效地面语义 id（无覆盖规则时 = 底板语义）。 */
  semantic: number;
  /** 底板语义 id（原值，便于对比）。 */
  baseSemantic: number;
  /** 求值时的相位 id（无 environment 规则时为空串）。 */
  phaseId: string;
  /** 相位内进度 [0, 1)（无规则时 0）。 */
  progress: number;
  /** 实际命中的 groundOverrides 下标（按应用顺序）。 */
  applied: number[];
}

/** 覆盖率规格：常量或随相位进度线性。 */
function coverageAt(override: GroundOverride, progress: number): number {
  const coverage = override.coverage;
  if (coverage === undefined) return 1;
  const raw =
    typeof coverage === "number"
      ? coverage
      : coverage.from + (coverage.to - coverage.from) * progress;
  return Math.max(0, Math.min(1, raw));
}

/** 格坐标 → [0, 1) 确定性 hash（seed + phaseId + x + y；纯函数）。 */
export function groundCoverageHash(
  seed: number,
  phaseId: string,
  x: number,
  y: number,
): number {
  return mixSeed(seed, "effective-ground", phaseId, Math.floor(x), Math.floor(y)) / 0x1_0000_0000;
}

/** 一条覆盖规则在当前格/相位下是否命中（不含语义比较）。 */
function matchesContext(
  override: GroundOverride,
  query: GroundQuery,
  phaseId: string,
  progress: number,
): boolean {
  if (override.phaseId !== phaseId) return false;

  const { level, region } = query;
  if (override.minLevel !== undefined && level < override.minLevel) return false;
  if (override.maxLevel !== undefined && level > override.maxLevel) return false;

  const minProgress = override.minProgress ?? 0;
  const maxProgress = override.maxProgress ?? 1;
  if (progress < minProgress || progress > maxProgress) return false;

  if (override.regions && override.regions.length > 0) {
    if (region === undefined || !override.regions.includes(region)) return false;
  }
  if (override.excludeRegions && region !== undefined && override.excludeRegions.includes(region)) {
    return false;
  }
  return true;
}

/**
 * 核心派生（纯函数）：把底板语义按配置逐条映射为有效语义。
 *
 * @param rule environment 规则（undefined = 无派生）
 * @param tick 世界 tick（相位/进度由它派生）
 * @param query 格上下文
 */
export function deriveEffectiveGround(
  rule: EnvironmentRule | undefined,
  tick: number,
  query: GroundQuery,
): EffectiveGroundView {
  const baseSemantic = query.baseSemantic;
  if (!rule) {
    return { semantic: baseSemantic, baseSemantic, phaseId: "", progress: 0, applied: [] };
  }
  const phase = phaseAt(tick, rule);
  const overrides = rule.groundOverrides ?? [];
  let semantic = baseSemantic;
  const applied: number[] = [];

  for (let index = 0; index < overrides.length; index++) {
    const override = overrides[index];
    if (override.fromSemantic !== semantic) continue;
    if (!matchesContext(override, query, phase.phaseId, phase.progress)) continue;

    const coverage = coverageAt(override, phase.progress);
    if (coverage <= 0) continue;
    if (coverage < 1) {
      const hash = groundCoverageHash(rule.seed ?? 0, phase.phaseId, query.x, query.y);
      if (hash >= coverage) continue;
    }

    semantic = override.toSemantic;
    applied.push(index);
  }

  return {
    semantic,
    baseSemantic,
    phaseId: phase.phaseId,
    progress: phase.progress,
    applied,
  };
}

/** 全部派生字段（诊断/测试/客户端工具用）。 */
export function effectiveGroundViewAt(
  world: GameWorld,
  x: number,
  y: number,
  mapKey: string = world.defaultMapId,
): EffectiveGroundView {
  const geometry = world.maps[mapKey];
  if (!geometry) {
    return { semantic: 0, baseSemantic: 0, phaseId: "", progress: 0, applied: [] };
  }
  return deriveEffectiveGround(getEnvironmentRule(world), world.time.tick, {
    x,
    y,
    baseSemantic: tileAt(geometry, x, y),
    level: levelAt(geometry, x, y),
    region: regionOf(geometry, x, y),
  });
}

/**
 * 有效地面语义 id（玩法主要入口）。x/y 为 **tile 坐标**；越界/未知地图返回 0
 * （与 `tileAt` 的越界安全语义一致）。
 *
 * @param mapKey 地图 key；缺省 = world.defaultMapId
 */
export function effectiveGroundAt(
  world: GameWorld,
  x: number,
  y: number,
  mapKey: string = world.defaultMapId,
): number {
  return effectiveGroundViewAt(world, x, y, mapKey).semantic;
}

/**
 * 像素坐标版本（便捷封装）：按几何的 tileWidth/tileHeight 向下取整换算。
 * 越界同样返回 0。
 */
export function effectiveGroundAtPixel(
  world: GameWorld,
  px: number,
  py: number,
  mapKey: string = world.defaultMapId,
): number {
  const geometry: MapGeometry | undefined = world.maps[mapKey];
  if (!geometry) return 0;
  const { tileWidth, tileHeight } = geometry.grid;
  return effectiveGroundAt(
    world,
    Math.floor(px / tileWidth),
    Math.floor(py / tileHeight),
    mapKey,
  );
}
