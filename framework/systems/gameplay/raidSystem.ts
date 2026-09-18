/**
 * 周期袭击系统（raidSystem）：按规则文件周期在玩家周围刷敌对波。
 *
 * 规则来源 rules/raid.json（RaidRuleSchema，见 config/schema/RuleSchema.ts），
 * 每 tick 从 world.gameDef.resolvedRules["raid"] 读取（缺失/畸形 → no-op）：
 * - intervalTicks：门控周期（world.time.tick % intervalTicks === 0 对齐槽）
 * - waveSize / kinds：缺省波构建器——每成员从 kinds 池确定性挑一种
 * - radiusTiles：落位搜索半径（tile，缺省 4）
 * - condition：整波刷怪条件名（spawnConditions 注册表引用，如 isNight；
 *   未知名经 getSpawnCondition 求值时抛错，与演化引擎同约定）
 * - waveRef：可选规则模块引用（registerRuleModule 扩展点，框架零新概念）——
 *   模块 (world, playerEid, ctx) 返回 Array<{ kind, x?, y? }> 完全接管缺省波
 *   构建器（x/y 缺省时仍走玩家附近随机合法落位）；未知模块 id 求值时抛错
 *
 * 落位合法性与巢穴系统共用同一套语义（spawnPlacement）：锚点 tile 可走 +
 * footprint 不压同图实体/地图阻挡；确定性随机流由 (tick, playerEid, 成员序,
 * 尝试序) 派生。游戏无关——kinds 是 archetype kind 字符串；谁袭击谁、
 * 什么物种全由 game/ 配置与规则模块决定。
 */
import { query } from "bitecs";
import { Player, Transform } from "components";
import { createRng } from "framework/map/generate/rng";
import { getRuleModule } from "framework/api";
import { getSpawnCondition } from "framework/systems/gameplay/spawnConditions";
import {
  PLACEMENT_MAX_ATTEMPTS,
  DEFAULT_SPAWN_RADIUS_TILES,
  attemptSeed,
  effectiveMapOf,
  randomTileCenterNear,
  trySpawnAtPixel,
} from "framework/systems/gameplay/spawnPlacement";
import type { RaidRule } from "framework/config/schema/RuleSchema";
import type { GameWorld } from "world";

/** 波成员规格（waveRef 模块返回值元素）：kind 必填；x/y 缺省走玩家附近随机合法落位。 */
export interface RaidWaveMember {
  kind: string;
  x?: number;
  y?: number;
}

/** waveRef 模块调用上下文（第三参数）。 */
export interface RaidWaveContext {
  /** 当前门控 tick。 */
  tick: number;
  /** 玩家所属地图 id（模块可据此分图）。 */
  mapId: string;
  /** 规则声明的落位搜索半径（tile）。 */
  radiusTiles: number;
  /** 原始规则对象（模块可读其余自定义字段——schema passthrough 透传）。 */
  rule: RaidRule;
}

export function createRaidSystem(_config?: Record<string, unknown>) {
  // 波成员 kind 原型缺失告警去重（每 kind 一次）
  const warnedMissingKinds = new Set<string>();

  return function raidSystem(world: GameWorld): GameWorld {
    const rule = world.gameDef.resolvedRules["raid"] as RaidRule | undefined;
    if (!rule) return world;
    const interval = rule.intervalTicks;
    if (typeof interval !== "number" || interval < 1) return world;
    // 对齐槽门控（与演化引擎 every 槽同一约定）
    if (world.time.tick % interval !== 0) return world;

    // 整波条件门控：未知条件名经 getSpawnCondition 求值时抛错（与演化引擎同约定）
    if (rule.condition !== undefined) {
      const condition = getSpawnCondition(rule.condition);
      if (!condition(world)) return world;
    }

    const radiusTiles =
      typeof rule.radiusTiles === "number" && rule.radiusTiles > 0
        ? Math.floor(rule.radiusTiles)
        : DEFAULT_SPAWN_RADIUS_TILES;
    const kinds = Array.isArray(rule.kinds) ? rule.kinds : [];
    const waveSize =
      typeof rule.waveSize === "number" ? Math.max(0, Math.floor(rule.waveSize)) : 0;

    for (const playerEid of query(world, [Player, Transform])) {
      const mapId = effectiveMapOf(world, playerEid);
      const geometry = mapId === "" ? undefined : world.maps[mapId];
      if (!geometry) continue;

      // 波规格：waveRef 规则模块完全接管缺省构建器（registerRuleModule 扩展点，
      // 调用惯例同 combatSystem 的 damageFormulaRef）；未知模块 id 求值时抛错
      let wave: RaidWaveMember[];
      if (rule.waveRef !== undefined) {
        const ctx: RaidWaveContext = { tick: world.time.tick, mapId, radiusTiles, rule };
        const spec = getRuleModule(rule.waveRef)(world, playerEid, ctx);
        wave = Array.isArray(spec) ? (spec as RaidWaveMember[]) : [];
      } else {
        wave = [];
        for (let i = 0; i < waveSize && kinds.length > 0; i += 1) {
          const rng = createRng(attemptSeed(world.time.tick, playerEid, i, 0));
          wave.push({ kind: kinds[rng.int(kinds.length)] });
        }
      }

      const { tileWidth, tileHeight } = geometry.grid;
      const playerTx = Math.floor(Transform.x[playerEid] / tileWidth);
      const playerTy = Math.floor(Transform.y[playerEid] / tileHeight);

      for (let i = 0; i < wave.length; i += 1) {
        const member = wave[i];
        if (!member || typeof member.kind !== "string" || member.kind === "") continue;
        if (!world.archetypes.has(member.kind)) {
          if (!warnedMissingKinds.has(member.kind)) {
            warnedMissingKinds.add(member.kind);
            world.logger.warn("raid wave kind archetype is not registered; member skipped", {
              playerEid,
              kind: member.kind,
            });
          }
          continue;
        }
        const archetype = world.archetypes.get(member.kind);

        if (typeof member.x === "number" && typeof member.y === "number") {
          // 显式落点：模块给定坐标，单点合法性校验（无随机搜索，不满足即跳过）
          trySpawnAtPixel(world, geometry, mapId, archetype, member.x, member.y);
          continue;
        }
        // 缺省落位：玩家半径内随机 tile + 可走/占位合法性，每成员尝试数有界
        for (let attempt = 0; attempt < PLACEMENT_MAX_ATTEMPTS; attempt += 1) {
          const rng = createRng(attemptSeed(world.time.tick, playerEid, i, attempt + 1));
          const { px, py } = randomTileCenterNear(rng, geometry, playerTx, playerTy, radiusTiles);
          if (trySpawnAtPixel(world, geometry, mapId, archetype, px, py)) break;
        }
      }
    }

    return world;
  };
}

/** 无配置默认实例（向后兼容直接注册形态）。 */
export function raidSystem(world: GameWorld): GameWorld {
  return createRaidSystem()(world);
}
