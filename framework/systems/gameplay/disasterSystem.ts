/**
 * 天气灾害系统（disasterSystem）：WorldClock 灾害天气窗口下的周期灾害效果。
 *
 * 规则来源 rules/disasters.json（DisasterRuleSchema，见 config/schema/RuleSchema.ts），
 * 每 tick 从 world.gameDef.resolvedRules["disasters"] 读取（缺失/畸形 → no-op）：
 * - weatherId：灾害窗口开关——environmentAt(world).weatherId 与之相等时激活
 *   （WorldClock 纯函数派生，同 tick 恒同判定）；
 * - intervalTicks：灾害效果触发周期（对齐槽，缺省 600）；
 * - wildfire：野火——确定性 rng（rngFrom(tick, ...) 纯派生）在每个在线玩家
 *   周边半径内取点燃候选点：可燃语义格上若有可燃实体，原型带状态机则发
 *   点燃信号（燃烧链由原型配置编排：烧尽 despawn + scorch-ground 焦土效果）、
 *   否则直接损毁并在脚下写回焦土；空可燃格直接写回焦土（地面明火）；
 * - storm：风暴——露天（isIndoors 判定，切片 6 室内语义）实体按周期直扣
 *   Health（自然灾害不走防御减免）；死亡统一归 deathSystem。
 *
 * 确定性与离线边界：灾害触发点全部由 (tick, 作用域) 纯派生（rngFrom），同
 * 种子同 tick 恒同结果；离线补差只跑演化引擎 + 状态机/族群快进（不重放
 * tick 系统），灾害与写回入口切片同口径**不参与补差**。灾害运行时无累积
 * 状态（窗口判定 + 对齐槽门控均为 tick 纯函数），读档即自然续跑。
 *
 * 游戏无关——weatherId/语义 id/kind 全是 game/ 配置字符串与数值；storm/
 * wildfire/burn/scorch 是通用灾害机制词。
 */
import { hasComponent, query } from "bitecs";
import { Health, Kind, Player, Transform, entityMapOf } from "components";
import { isOfflineRetained } from "components/offline";
import { environmentAt } from "framework/simulation/worldClock";
import { rngFrom } from "framework/simulation/rng";
import { setGround } from "framework/map/runtime/terrainWriteback";
import { entityIsIndoors } from "framework/map/runtime/indoors";
import { signalStateMachine } from "framework/simulation/stateMachine";
import { destroyEntity } from "framework/entities/destroyEntity";
import { randomTileCenterNear } from "framework/systems/gameplay/spawnPlacement";
import type { MapGeometry } from "map/geometry/types";
import type { DisasterRule, StormRule, WildfireRule } from "framework/config/schema/RuleSchema";
import type { GameWorld } from "world";

/** 灾害效果触发周期缺省值（tick）：600 ≈ 30s @20tps。 */
const DEFAULT_INTERVAL_TICKS = 600;
/** 每个在线玩家每次触发的点燃尝试缺省数。 */
const DEFAULT_WILDFIRE_ATTEMPTS = 4;
/** 点燃搜索半径缺省值（tile）。 */
const DEFAULT_WILDFIRE_RADIUS_TILES = 6;
/** 点燃信号名缺省值（可燃实体状态机的 on 迁移引用名）。 */
const DEFAULT_IGNITE_SIGNAL = "ignite";

/** 对齐槽门控（与演化引擎/袭击导演同一约定）。 */
function alignedSlot(tick: number, interval: number): boolean {
  return interval > 0 && tick % interval === 0;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function createDisasterSystem(_config?: Record<string, unknown>) {
  return function disasterSystem(world: GameWorld): GameWorld {
    const rule = world.gameDef.resolvedRules["disasters"] as DisasterRule | undefined;
    if (!rule || typeof rule.weatherId !== "string" || rule.weatherId === "") return world;

    // 灾害窗口：WorldClock 派生天气命中配置 id 才激活
    if (environmentAt(world).weatherId !== rule.weatherId) return world;

    const tick = world.time.tick;
    const interval = positiveInt(rule.intervalTicks, DEFAULT_INTERVAL_TICKS);
    if (!alignedSlot(tick, interval)) return world;

    if (rule.wildfire) wildfireStep(world, rule.wildfire, tick);
    if (rule.storm) stormStep(world, rule, tick);
    return world;
  };
}

/**
 * 可燃实体索引：kind ∈ flammableKinds 的实体按「图 → tile 线性索引 → eid」
 * 归置（同格多实体取 eid 最小者，保证确定）。每次野火触发构建一次。
 */
function flammableEntityIndex(
  world: GameWorld,
  kinds: Set<string>,
): Map<string, Map<number, number>> {
  const index = new Map<string, Map<number, number>>();
  if (kinds.size === 0) return index;
  for (const eid of query(world, [Transform])) {
    const kind = Kind[eid] ?? "";
    if (!kinds.has(kind)) continue;
    const mapId = entityMapOf(world, eid);
    const geometry = mapId === "" ? undefined : world.maps[mapId];
    if (!geometry) continue;
    const { width, tileWidth, tileHeight } = geometry.grid;
    const tx = Math.floor(Transform.x[eid] / tileWidth);
    const ty = Math.floor(Transform.y[eid] / tileHeight);
    if (tx < 0 || ty < 0 || tx >= width || ty >= geometry.grid.height) continue;
    let byTile = index.get(mapId);
    if (!byTile) {
      byTile = new Map<number, number>();
      index.set(mapId, byTile);
    }
    const tileIndex = ty * width + tx;
    const existing = byTile.get(tileIndex);
    if (existing === undefined || eid < existing) byTile.set(tileIndex, eid);
  }
  return index;
}

/**
 * 点燃一个可燃实体：原型带状态机 → 发点燃信号（燃烧链由原型配置编排，
 * 已在燃烧中的实体信号自然 no-op）；否则直接损毁并在脚下写回焦土。
 */
function igniteFlammableEntity(
  world: GameWorld,
  eid: number,
  signal: string,
  scorchGround: number,
): void {
  const kind = Kind[eid] ?? "";
  const archetype = kind !== "" ? world.archetypes.get(kind) : undefined;
  if (archetype?.components && archetype.components["StateMachine"] !== undefined) {
    signalStateMachine(world, eid, signal);
    return;
  }
  // 直接损毁路径：先写回脚下焦土（需 Transform 定位），再销毁实体
  const mapId = entityMapOf(world, eid);
  const geometry = mapId === "" ? undefined : world.maps[mapId];
  if (geometry) {
    const { width, tileWidth, tileHeight } = geometry.grid;
    const tx = Math.floor(Transform.x[eid] / tileWidth);
    const ty = Math.floor(Transform.y[eid] / tileHeight);
    if (tx >= 0 && ty >= 0 && tx < width && ty < geometry.grid.height) {
      setGround(world, mapId, ty * width + tx, scorchGround, world.time.tick);
    }
  }
  destroyEntity(world, eid);
}

/**
 * 野火步：确定性点燃候选点 → 可燃实体点燃/损毁，或空可燃格直接写回焦土。
 * 点燃锚点 = 在线玩家（断线保留期不可见语义；无玩家不点火——与导演暂停、
 * 离线补差不重放灾害同口径）。
 */
function wildfireStep(world: GameWorld, wildfire: WildfireRule, tick: number): void {
  const grounds = Array.isArray(wildfire.flammableGrounds) ? wildfire.flammableGrounds : [];
  const scorchGround = wildfire.scorchGround;
  if (grounds.length === 0 || typeof scorchGround !== "number") return;
  if (scorchGround < 0 || scorchGround > 255) return;

  const kinds = Array.isArray(wildfire.flammableKinds)
    ? new Set(wildfire.flammableKinds)
    : new Set<string>();
  const flammableAt = flammableEntityIndex(world, kinds);
  const signal =
    typeof wildfire.igniteSignal === "string" && wildfire.igniteSignal !== ""
      ? wildfire.igniteSignal
      : DEFAULT_IGNITE_SIGNAL;
  const attempts = positiveInt(wildfire.attempts, DEFAULT_WILDFIRE_ATTEMPTS);
  const radiusTiles = positiveInt(wildfire.radiusTiles, DEFAULT_WILDFIRE_RADIUS_TILES);

  for (const playerEid of query(world, [Player, Transform])) {
    if (isOfflineRetained(world, playerEid)) continue;
    const mapId = entityMapOf(world, playerEid);
    const geometry = mapId === "" ? undefined : world.maps[mapId];
    if (!geometry) continue;
    const byTile = flammableAt.get(mapId);

    const { width, height, tileWidth, tileHeight } = geometry.grid;
    const ptx = Math.floor(Transform.x[playerEid] / tileWidth);
    const pty = Math.floor(Transform.y[playerEid] / tileHeight);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // 确定性点燃点：rngFrom(tick, 作用域, playerEid, attempt) 纯派生——
      // 同种子同 tick 恒同候选序列
      const rng = rngFrom(tick, "wildfire", playerEid, attempt);
      const { px, py } = randomTileCenterNear(rng, geometry, ptx, pty, radiusTiles);
      const tx = Math.floor(px / tileWidth);
      const ty = Math.floor(py / tileHeight);
      if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
      const tileIndex = ty * width + tx;
      if (!grounds.includes(geometry.tiles[tileIndex]!)) continue;

      const entity = byTile?.get(tileIndex);
      // 快照索引可能含上一次尝试已烧毁的实体：以 Transform 活性为准，
      // 已死实体跳过点燃（其脚下焦土已由烧毁路径写回，重复写为幂等 no-op）
      if (entity !== undefined && hasComponent(world, entity, Transform)) {
        igniteFlammableEntity(world, entity, signal, scorchGround);
        continue;
      }
      // 空可燃格：地面明火直接烧穿——写回焦土（callerTick 用当前 tick）
      setGround(world, mapId, tileIndex, scorchGround, tick);
    }
  }
}

/**
 * 风暴步：露天（isIndoors 判定）实体按周期直扣 Health。
 * 断线保留期实体跳过（与需求衰减同口径——离线玩家不被天气消耗）；
 * 已死实体跳过（deathSystem 统一收尾）。
 */
function stormStep(world: GameWorld, rule: DisasterRule, tick: number): void {
  const storm = rule.storm;
  if (!storm) return;
  const damage = storm.damage;
  if (typeof damage !== "number" || !(damage > 0)) return;
  const interval = positiveInt(
    storm.damageIntervalTicks,
    positiveInt(rule.intervalTicks, DEFAULT_INTERVAL_TICKS),
  );
  if (!alignedSlot(tick, interval)) return;

  for (const eid of query(world, [Health])) {
    if (isOfflineRetained(world, eid)) continue;
    if ((Health.current[eid] ?? 0) <= 0) continue;
    // 室内免疫（切片 6 室内语义派生查询；无归属图/未知图按露天处理）
    if (entityIsIndoors(world, eid)) continue;
    Health.current[eid] = (Health.current[eid] ?? 0) - damage;
  }
}

/** 无配置默认实例（向后兼容直接注册形态）。 */
export function disasterSystem(world: GameWorld): GameWorld {
  return createDisasterSystem()(world);
}
