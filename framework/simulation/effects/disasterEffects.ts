/**
 * 灾害相关内建效果（framework/simulation/effects/disasterEffects.ts）——游戏无关。
 *
 * 与 builtinEffects 分文件注册（bootstrap 并列调用，注册表查重兜底重复）：
 * 本文件只放「灾害机制」效果——当前仅 scorch-ground（在实体脚下写回焦土
 * 地面语义），供状态机烧尽迁移等声明式引用。
 *
 * 写回纪律：经 map/runtime/terrainWriteback 的 setGround 入口（唯一合法通道），
 * callerTick 用当前 tick——状态机迁移效果在迁移 tick 语境下求值
 * （applyTransition 临时拨 tick），离线快进时即为重放标注形态。
 */
import { entityMapOf } from "components";
import type { GameWorld } from "framework/world";
import { registerEffect, positionOfEntity } from "framework/simulation/effects/effectRegistry";
import { setGround } from "framework/map/runtime/terrainWriteback";

/** 参数读取工具：数值参数（非法/缺失回退缺省值）。 */
function numParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(params[key]);
  return Number.isFinite(value) ? value : fallback;
}

/** 焦土效果注册名（EffectSpec.name 引用键）。 */
export const EFFECT_SCORCH_GROUND = "scorch-ground";

/** 注册灾害相关内建效果（bootstrap 时调用一次；重复注册抛错）。 */
export function registerDisasterEffects(): void {
  /**
   * scorch-ground：把来源实体脚下的地面语义写回为 params.semantic（焦土）。
   *
   * params：semantic（地面语义 id 0-255，必填）。作用位置缺省为来源实体
   * 位置；无归属图 / 语义 id 非法时失败（返回 false）。写回走 terrain
   * 写回入口（指纹/纪元/脏格全链），callerTick 取当前 tick。
   */
  registerEffect(EFFECT_SCORCH_GROUND, (ctx) => {
    const semantic = numParam(ctx.params, "semantic", -1);
    if (!Number.isInteger(semantic) || semantic < 0 || semantic > 255) return false;

    const pos = ctx.position ?? positionOfEntity(ctx.world, ctx.source);
    if (!pos) return false;

    const mapId = entityMapOf(ctx.world, ctx.source);
    const geometry = mapId === "" ? undefined : ctx.world.maps[mapId];
    if (!geometry) return false;

    const { width, tileWidth, tileHeight } = geometry.grid;
    const tileIndex = Math.floor(pos.y / tileHeight) * width + Math.floor(pos.x / tileWidth);
    return setGround(ctx.world, mapId, tileIndex, semantic, ctx.world.time.tick);
  });
}
