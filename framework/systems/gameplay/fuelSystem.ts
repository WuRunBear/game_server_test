import { hasComponent, query } from "bitecs";
import { LightSource, NetworkId, Transform } from "components";
import { entityLevelOf } from "framework/components/entityLevel";
import { sameLevelDistance } from "framework/utils/gameplayDistance";
import { removeContainer } from "framework/economy/container";
import { craftingStationRange, stationsInRange } from "framework/systems/gameplay/craftingSystem";
import type { GameWorld } from "world";

/**
 * fuelSystem：站点燃料机制（tick 系统函数 + 加油原子，命令通道驱动）。
 *
 * 燃料数值全走配置（crafting 规则的 fuel 段，结构收窄 fail-fast）：
 * - `burnMsPerTick`：每 tick 从点亮光源扣除的燃料毫秒——未配置 fuel 段则
 *   不燃烧（机制缺省关闭，历史配置零回归）；
 * - `items`：燃料物品表（kind → 每件补充的燃料毫秒），加油原子按声明序
 *   取持有者背包中第一种可扣的物品。
 *
 * 燃料承载在既有 LightSource.fuelRemainingMs 上（字段已存在无消费者）：
 * fuelRemainingMs ≤ 0 视为熄灭——光照判定（utils/light）天然失效，
 * craftingSystem 的站点匹配将燃料型站点（带 LightSource 的 CraftingStation）
 * 视为不可用。消费闭环由此打通。`fuelInfinite=1` 的光源显式声明无限燃料：
 * 燃烧/离线快进均跳过（不消耗），且燃料值不影响点亮/站点可用判定；加油仍
 * 允许（写入值不影响无限语义，保持交互入口一致）。
 *
 * 游戏无关——kind/毫秒均为通用机制词，具体燃料物与数值由 game/ 配置约定。
 * 注：燃烧在线由 GameSimulation beforeSystems 逐 tick 推进；离线补差经
 * `fastForwardFuelBurn` 闭式扣减（存量状态，无需重放 tick）——在线/离线
 * 语义一致（离线期间燃料真实消耗）。
 */

/** 收窄后的燃料配置（fuel 段缺省 = 机制关闭）。 */
export interface FuelConfig {
  /** 每 tick 燃烧的燃料毫秒（> 0）。 */
  burnMsPerTick: number;
  /** 燃料物品表：kind → 每件补充的燃料毫秒（声明序 = 加油取物品的优先序）。 */
  fuelItems: Map<string, number>;
}

/** 燃料配置缓存：按 fuel 段对象身份缓存（整体替换规则对象即重新解析）。 */
const fuelCache = new WeakMap<object, FuelConfig>();

/** 解析 fuel 段（缺省返回 undefined = 不燃烧）。非法配置抛错（fail-fast）。 */
export function resolveFuelConfig(world: GameWorld): FuelConfig | undefined {
  const rawRules = world.gameDef.resolvedRules["crafting"] as { fuel?: unknown } | undefined;
  const raw = rawRules?.fuel;
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("crafting rules: fuel must be an object");
  }

  const cached = fuelCache.get(raw);
  if (cached) return cached;

  const burnMsPerTick = (raw as { burnMsPerTick?: unknown }).burnMsPerTick;
  if (typeof burnMsPerTick !== "number" || !Number.isFinite(burnMsPerTick) || burnMsPerTick <= 0) {
    throw new Error("crafting rules: fuel.burnMsPerTick must be a positive number");
  }

  const itemsRaw = (raw as { items?: unknown }).items;
  if (typeof itemsRaw !== "object" || itemsRaw === null || Array.isArray(itemsRaw)) {
    throw new Error("crafting rules: fuel.items must be an object of kind -> fuel ms");
  }
  const entries = Object.entries(itemsRaw as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error("crafting rules: fuel.items must declare at least one fuel kind");
  }
  const fuelItems = new Map<string, number>();
  for (const [kind, ms] of entries) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
      throw new Error(`crafting rules: fuel.items["${kind}"] must be a positive number of ms`);
    }
    fuelItems.set(kind, ms);
  }

  const parsed: FuelConfig = { burnMsPerTick, fuelItems };
  fuelCache.set(raw, parsed);
  return parsed;
}

/** 构造期校验入口：解析 fuel 段，非法配置即抛（GameSimulation 构造时预热）。 */
export function validateFuelRules(world: GameWorld): void {
  resolveFuelConfig(world);
}

/**
 * 每 tick 燃烧：对全部点亮（fuelRemainingMs > 0）且非无限燃料
 * （fuelInfinite=0）的 LightSource 扣除 burnMsPerTick（下限 0，熄灭后不再
 * 变化）。未配置 fuel 段时空转。
 */
export function stepFuelBurn(world: GameWorld): void {
  const config = resolveFuelConfig(world);
  if (!config) return;
  for (const eid of query(world, [LightSource])) {
    if (LightSource.fuelInfinite[eid]) continue; // 无限燃料：不消耗
    const current = LightSource.fuelRemainingMs[eid] ?? 0;
    if (current <= 0) continue;
    LightSource.fuelRemainingMs[eid] = Math.max(0, current - config.burnMsPerTick);
  }
}

/**
 * 离线燃料闭式快进：把燃烧一次性折算 elapsedTicks 个 tick 的量。
 *
 * 语义与在线逐 tick 燃烧完全一致（同一 burnMsPerTick、同一"≤0 视为熄灭"
 * 钳制），仅把 N 次减法合并为 `fuelRemainingMs -= burnMsPerTick × N`
 * （下限 0）——纯计算、确定性，不重放 tick。耗尽的光源/燃料型站点沿用
 * 既有失效规则（fuelRemainingMs ≤ 0 → 光照与合成站点匹配自然失效）。
 *
 * 未配置 fuel 段（机制关闭）、elapsedTicks ≤ 0 时空转（零影响）。
 */
export function fastForwardFuelBurn(world: GameWorld, elapsedTicks: number): void {
  if (!Number.isFinite(elapsedTicks) || elapsedTicks <= 0) return;
  const config = resolveFuelConfig(world);
  if (!config) return;

  const burnMs = config.burnMsPerTick * elapsedTicks;
  for (const eid of query(world, [LightSource])) {
    if (LightSource.fuelInfinite[eid]) continue; // 无限燃料：离线也不消耗
    const current = LightSource.fuelRemainingMs[eid] ?? 0;
    if (current <= 0) continue;
    LightSource.fuelRemainingMs[eid] = Math.max(0, current - burnMs);
  }
}

/**
 * 加油原子：给附近（crafting stationRange 内、同层）的燃料型站点
 * （CraftingStation + LightSource）补充燃料。
 *
 * - 目标：targetNetworkId 命中的站点；缺省取最近的一座（超 range/异层拒）。
 * - 燃料：按 fuel.items 声明序取持有者背包中第一种存量 ≥ 1 的物品，扣 1 件、
 *   按配置值增加站点 fuelRemainingMs。
 *
 * @returns 是否加油成功（无站点/无燃料物品/无 fuel 配置均拒，零副作用）
 */
export function refuelStation(world: GameWorld, playerEid: number, targetNetworkId?: number): boolean {
  const config = resolveFuelConfig(world);
  if (!config) return false;
  if (!hasComponent(world, playerEid, Transform)) return false;

  const range = craftingStationRange(world);
  const px = Transform.x[playerEid];
  const py = Transform.y[playerEid];
  const playerLevel = entityLevelOf(playerEid);

  let station = -1;
  let bestDistance = Infinity;
  for (const eid of stationsInRange(world, playerEid, range)) {
    if (!hasComponent(world, eid, LightSource)) continue; // 仅燃料型站点有加油口
    if (targetNetworkId !== undefined && NetworkId.value[eid] !== targetNetworkId) continue;
    const d = sameLevelDistance(px, py, playerLevel, Transform.x[eid], Transform.y[eid], entityLevelOf(eid));
    if (d !== undefined && d < bestDistance) {
      bestDistance = d;
      station = eid;
    }
  }
  if (station < 0) return false;

  for (const [kind, fuelMs] of config.fuelItems) {
    if (!removeContainer(world, { type: "inventory", eid: playerEid }, kind, 1)) continue;
    LightSource.fuelRemainingMs[station] = (LightSource.fuelRemainingMs[station] ?? 0) + fuelMs;
    return true;
  }
  return false; // 无可用燃料物品
}
