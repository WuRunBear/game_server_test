import { hasComponent, query } from "bitecs";
import { CraftingStation, Inventory, LightSource, Transform } from "components";
import { entityLevelOf } from "framework/components/entityLevel";
import { sameLevelDistance } from "framework/utils/gameplayDistance";
import type { GameWorld } from "world";
import { addToInventory } from "framework/systems/gameplay/inventoryOps";
import {
  hasSpawnCondition,
  getSpawnCondition,
  type SpawnCondition,
} from "framework/systems/gameplay/spawnConditions";
import type { CraftingRecipe, EnvironmentRule } from "framework/config/schema/RuleSchema";

/**
 * craftingSystem：合成原子模块（无 tick 体，命令通道驱动）。
 *
 * 服务端权威原子 `craftRecipe`：按 recipe 校验并执行「inputs 消耗 → outputs 产出」。
 * 校验顺序（任一失败即拒，且零副作用）：
 * 1. recipe 存在
 * 2. 解锁门（科技树）：配方声明 unlock.condition 时经 spawnConditions 注册表求值，
 *    条件不满足即拒（季节配方 = 带参条件 inPhase/isWeather 的直接消费点）
 * 3. 合成者有背包
 * 4. 站点：recipe.stationType ≠ 0 时，须在 stationRange 内有匹配类型的 CraftingStation；
 *    带 LightSource 的站点（燃料型站点）fuelRemainingMs ≤ 0 视为熄火不可用
 * 5. 缺料：背包中每种 input 的合计数量 ≥ 需求
 * 6. 满包：dry-run 克隆槽位模拟 addToInventory，全部 output 能完整放入才继续
 *
 * 制作时长（durationTicks，缺省 0 = 即时）：延时配方在校验通过后立即消耗 inputs，
 * 产出挂入 world.craftingJobs，由 `stepCraftingJobs` 每 tick 推进——到点时重验
 * 站点（含燃料）与背包空间：不满足则**挂起重试**（不丢已耗材料、不丢产出），
 * 直到可产出或玩家经 `cancelCrafting` 取消（取消按配方回退 inputs，放不下则拒绝取消）。
 *
 * 配置收窄（fail-fast）：unlock/durationTicks 与燃料段落为规则文件的透传字段
 * （RuleSchema 的 crafting 段 .passthrough()），本模块在首次解析时逐项校验——
 * 未知条件名/非法参数/非法时长/非法燃料配置直接抛错（构造期由 GameSimulation
 * 预热触发），参照生成积木 parseParams 的收窄风格。schema 形式化后置。
 *
 * 游戏无关——kind/stationType/recipe/condition 均为配置引用，框架不识别具体物品语义。
 */

const DEFAULT_STATION_RANGE = 64;

/** 解析后的配方扩展字段（unlock/durationTicks 收窄结果）。 */
interface RecipeExtension {
  /** 制作时长（tick）；0 = 即时完成。 */
  durationTicks: number;
  /** 解锁判定函数（已绑定参数）；未声明解锁时为 undefined。 */
  unlockCondition?: SpawnCondition;
}

/** 解析后的单条配方（原字段 + 收窄扩展）。 */
type ParsedRecipe = CraftingRecipe & RecipeExtension;

/** 解析后的 crafting 规则（recipes 按 id 索引 + 站点交互距离）。 */
interface ParsedCraftingRules {
  recipes: Map<string, ParsedRecipe>;
  stationRange?: number;
}

const EMPTY_RULES: ParsedCraftingRules = { recipes: new Map() };

/**
 * 规则解析缓存：按 crafting 规则对象身份缓存（WeakMap）——测试/工具在
 * 实例创建后整体替换规则对象时自动重新解析，原对象内字段变化不常见且
 * 以构造期校验为准。
 */
const rulesCache = new WeakMap<object, ParsedCraftingRules>();

/* ------------------------------------------------------------------ */
/* 配置收窄（fail-fast）                                                */
/* ------------------------------------------------------------------ */

/** 配置错误统一出口：消息点名配方与具体原因。 */
function recipeFail(recipeId: string, detail: string): never {
  throw new Error(`crafting recipe "${recipeId}": ${detail}`);
}

/**
 * 收窄单条配方的解锁/时长扩展字段：unlock.condition 须为已注册条件名
 * （带参条件 `基名:参数` 的参数非空；inPhase 的相位 id 须在 environment
 * 规则的相位程序内——配置了 environment 规则时），durationTicks 须为
 * 非负整数。非法即抛（构造期暴露配置笔误）。
 */
function parseRecipeExtension(recipe: CraftingRecipe): RecipeExtension {
  const raw = recipe as CraftingRecipe & {
    unlock?: unknown;
    durationTicks?: unknown;
  };

  // durationTicks：缺省 0（即时）；显式声明须为非负整数
  let durationTicks = 0;
  if (raw.durationTicks !== undefined) {
    const value = raw.durationTicks;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      recipeFail(recipe.id, `durationTicks must be a non-negative integer, got ${String(value)}`);
    }
    durationTicks = value;
  }

  // unlock：缺省无解锁门；声明时 { condition: "条件名" }
  if (raw.unlock === undefined) return { durationTicks };
  const unlock = raw.unlock;
  if (typeof unlock !== "object" || unlock === null || Array.isArray(unlock)) {
    recipeFail(recipe.id, "unlock must be an object with a \"condition\" field");
  }
  const conditionName = (unlock as { condition?: unknown }).condition;
  if (typeof conditionName !== "string" || conditionName.length === 0) {
    recipeFail(recipe.id, "unlock.condition must be a non-empty string");
  }
  if (!hasSpawnCondition(conditionName)) {
    recipeFail(recipe.id, `unlock.condition "${conditionName}" is not registered`);
  }

  // 带参条件结构校验：`基名:参数` 的参数非空；inPhase 的参数须命中相位程序
  const sep = conditionName.indexOf(":");
  if (sep > 0) {
    const arg = conditionName.slice(sep + 1);
    if (arg.length === 0) {
      recipeFail(recipe.id, `unlock.condition "${conditionName}" has an empty parameter`);
    }
    if (conditionName.slice(0, sep) === "inPhase") {
      if (pendingEnvRule && !pendingEnvRule.phases.some((phase) => phase.id === arg)) {
        recipeFail(
          recipe.id,
          `unlock.condition "${conditionName}" references a phase id not in the environment rule`,
        );
      }
    }
  }

  return { durationTicks, unlockCondition: getSpawnCondition(conditionName) };
}

/**
 * inPhase 参数校验用的 environment 规则：resolveCraftingRules 在解析期间
 * 暂存（解析以规则对象为键，不经过 world），解析结束即清空。
 */
let pendingEnvRule: EnvironmentRule | undefined;

/* ------------------------------------------------------------------ */

/**
 * 解析并取 crafting 规则（按规则对象身份缓存）。非法配置抛错（fail-fast）；
 * 未配置 crafting 规则时返回空表。
 */
function resolveCraftingRules(world: GameWorld): ParsedCraftingRules {
  const raw = world.gameDef.resolvedRules["crafting"];
  if (!raw || typeof raw !== "object") return EMPTY_RULES;

  const cached = rulesCache.get(raw);
  if (cached) return cached;

  // inPhase 参数校验需要 environment 规则：解析期间暂存到模块级 pending 槽
  pendingEnvRule = world.gameDef.resolvedRules["environment"] as EnvironmentRule | undefined;

  const recipesRaw = (raw as { recipes?: unknown }).recipes;
  const recipes = new Map<string, ParsedRecipe>();
  if (recipesRaw !== undefined) {
    if (!Array.isArray(recipesRaw)) {
      throw new Error("crafting rules: recipes must be an array");
    }
    for (const entry of recipesRaw) {
      const recipe = entry as CraftingRecipe;
      if (typeof recipe?.id !== "string" || recipe.id.length === 0) {
        throw new Error("crafting rules: every recipe must have a non-empty string id");
      }
      if (recipes.has(recipe.id)) {
        throw new Error(`crafting rules: duplicate recipe id "${recipe.id}"`);
      }
      recipes.set(recipe.id, { ...recipe, ...parseRecipeExtension(recipe) });
    }
  }

  const stationRangeRaw = (raw as { stationRange?: unknown }).stationRange;
  const parsed: ParsedCraftingRules = { recipes };
  if (stationRangeRaw !== undefined) {
    if (typeof stationRangeRaw !== "number" || !Number.isFinite(stationRangeRaw) || stationRangeRaw <= 0) {
      throw new Error("crafting rules: stationRange must be a positive number");
    }
    parsed.stationRange = stationRangeRaw;
  }

  rulesCache.set(raw, parsed);
  pendingEnvRule = undefined;
  return parsed;
}

/** 构造期校验入口：解析 crafting 规则，非法配置即抛（GameSimulation 构造时预热）。 */
export function validateCraftingRules(world: GameWorld): void {
  resolveCraftingRules(world);
}

/** 站点交互距离（crafting 规则 stationRange，缺省 64）；fuelSystem 加油判定共用。 */
export function craftingStationRange(world: GameWorld): number {
  return resolveCraftingRules(world).stationRange ?? DEFAULT_STATION_RANGE;
}

/* ------------------------------------------------------------------ */
/* 站点匹配（含燃料门）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 站点是否可用：带 LightSource 的站点（燃料型站点）fuelRemainingMs ≤ 0
 * 视为熄火——不可作为合成站点，也不再是加油目标判定外的合成依据。
 */
function stationUsable(world: GameWorld, eid: number): boolean {
  if (hasComponent(world, eid, LightSource) && (LightSource.fuelRemainingMs[eid] ?? 0) <= 0) {
    return false;
  }
  return true;
}

/**
 * 合成者附近 range 内的全部 CraftingStation 实体 eid（同层欧氏距离）。
 * 供本模块站点匹配与 fuelSystem 加油目标查找共用。
 */
export function stationsInRange(world: GameWorld, ownerEid: number, range: number): number[] {
  if (!hasComponent(world, ownerEid, Transform)) return [];
  const ox = Transform.x[ownerEid];
  const oy = Transform.y[ownerEid];
  const ownerLevel = entityLevelOf(ownerEid);
  const found: number[] = [];
  for (const eid of query(world, [CraftingStation, Transform])) {
    // 统一距离检查（前置修正 4）：同层欧氏距离（异层站点不可达）
    const d = sameLevelDistance(
      ox,
      oy,
      ownerLevel,
      Transform.x[eid],
      Transform.y[eid],
      entityLevelOf(eid),
    );
    if (d !== undefined && d <= range) found.push(eid);
  }
  return found;
}

/** 合成者附近 range 内是否存在指定 stationType 的可用（含燃料门）站点。 */
function hasStationNearby(
  world: GameWorld,
  ownerEid: number,
  stationType: number,
  range: number,
): boolean {
  return stationsInRange(world, ownerEid, range).some(
    (eid) => CraftingStation.stationType[eid] === stationType && stationUsable(world, eid),
  );
}

/* ------------------------------------------------------------------ */
/* 合成原子                                                             */
/* ------------------------------------------------------------------ */

/** 合成原子：ownerEid 按 recipeId 合成一次。返回是否成功（失败零副作用）。 */
export function craftRecipe(world: GameWorld, ownerEid: number, recipeId: string): boolean {
  const rules = resolveCraftingRules(world);
  const recipe = rules.recipes.get(recipeId);
  if (!recipe) return false;

  const inv = Inventory[ownerEid];
  if (!inv) return false;

  // 解锁门（科技树/季节条件）：条件不满足即拒（与缺料同语义，零副作用）
  if (recipe.unlockCondition && !recipe.unlockCondition(world)) return false;

  const stationType = recipe.stationType ?? 0;
  if (stationType !== 0) {
    if (!hasStationNearby(world, ownerEid, stationType, rules.stationRange ?? DEFAULT_STATION_RANGE)) {
      return false;
    }
  }

  if (!hasMaterials(inv, recipe)) return false;
  if (!outputsFit(world, inv, recipe)) return false;

  consumeMaterials(inv, recipe);

  if (recipe.durationTicks > 0) {
    // 延时制作：材料已扣，产出挂起至 finishTick（stepCraftingJobs 推进）
    enqueueCraft(world, ownerEid, {
      recipeId,
      finishTick: world.time.tick + recipe.durationTicks,
      durationTicks: recipe.durationTicks,
    });
    return true;
  }

  for (const out of recipe.outputs) {
    addToInventory(inv, world.gameDef.itemsByKind, out.kind, out.count);
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 延时制作：任务表推进 / 取消 / 进度查询                                 */
/* ------------------------------------------------------------------ */

/** 进行中的延时制作任务（运行时状态，不入档）。 */
export interface PendingCraft {
  /** 配方 id（crafting 规则引用）。 */
  recipeId: string;
  /** 预期完成 tick（到点后由 stepCraftingJobs 结算产出）。 */
  finishTick: number;
  /** 声明的制作时长（进度换算用）。 */
  durationTicks: number;
}

function enqueueCraft(world: GameWorld, ownerEid: number, job: PendingCraft): void {
  const jobs = world.craftingJobs.get(ownerEid);
  if (jobs) jobs.push(job);
  else world.craftingJobs.set(ownerEid, [job]);
}

/**
 * 每 tick 推进延时制作：到点（tick ≥ finishTick）的任务重验站点（含燃料门）
 * 与背包空间——站点失效或满包则**挂起重试**（保留任务、不丢已耗材料），满足
 * 则产出入包并移除任务。配方被配置移除或合成者失去背包时弃单（材料已耗，
 * 属配置变更语义，记 warn）。
 */
export function stepCraftingJobs(world: GameWorld): void {
  if (world.craftingJobs.size === 0) return;
  const rules = resolveCraftingRules(world);
  const tick = world.time.tick;

  for (const [ownerEid, jobs] of [...world.craftingJobs]) {
    const inv = Inventory[ownerEid];
    const remaining: PendingCraft[] = [];
    for (const job of jobs) {
      if (tick < job.finishTick) {
        remaining.push(job);
        continue;
      }
      const recipe = rules.recipes.get(job.recipeId);
      if (!recipe || !inv) {
        world.logger.warn("延时制作弃单：配方已移除或合成者无背包", {
          ownerEid,
          recipeId: job.recipeId,
          tick,
        });
        continue;
      }
      const stationType = recipe.stationType ?? 0;
      if (stationType !== 0 && !hasStationNearby(world, ownerEid, stationType, rules.stationRange ?? DEFAULT_STATION_RANGE)) {
        remaining.push(job); // 站点失效（拆除/熄火）：挂起等待恢复
        continue;
      }
      if (!outputsFit(world, inv, recipe)) {
        remaining.push(job); // 满包：挂起直到可产出（或玩家取消）
        continue;
      }
      for (const out of recipe.outputs) {
        addToInventory(inv, world.gameDef.itemsByKind, out.kind, out.count);
      }
    }
    if (remaining.length > 0) world.craftingJobs.set(ownerEid, remaining);
    else world.craftingJobs.delete(ownerEid);
  }
}

/**
 * 取消进行中的延时制作（按 recipeId 命中该合成者最早的一条任务）。
 *
 * 退料语义：按配方 inputs 回加背包（快照回退保证原子——退料放不下时
 * 拒绝取消，任务保留）；配方已被配置移除时仅弃单不退料。
 */
export function cancelCrafting(world: GameWorld, ownerEid: number, recipeId: string): boolean {
  const jobs = world.craftingJobs.get(ownerEid);
  const index = jobs?.findIndex((job) => job.recipeId === recipeId) ?? -1;
  if (!jobs || index < 0) return false;

  const inv = Inventory[ownerEid];
  const recipe = resolveCraftingRules(world).recipes.get(recipeId);
  if (recipe && inv) {
    const snapshot = {
      capacity: inv.capacity,
      slots: inv.slots.map((slot) => (slot ? { ...slot } : null)),
    };
    let leftover = 0;
    for (const input of recipe.inputs) {
      leftover += addToInventory(inv, world.gameDef.itemsByKind, input.kind, input.count);
    }
    if (leftover > 0) {
      Inventory[ownerEid] = snapshot; // 放不下：整体回退，拒绝取消
      return false;
    }
  }

  const remaining = jobs.filter((_, i) => i !== index);
  if (remaining.length > 0) world.craftingJobs.set(ownerEid, remaining);
  else world.craftingJobs.delete(ownerEid);
  return true;
}

/** 进度查询条目（测试/工具/未来客户端 UI 消费）。 */
export interface CraftingProgress {
  recipeId: string;
  finishTick: number;
  /** 距完成还剩的 tick 数（已到点为 0——到点未产出 = 挂起中）。 */
  remainingTicks: number;
  /** 进度 [0, 1)；挂起中恒 1（等的是产出条件而非时间）。 */
  progress: number;
}

/** 查询合成者的进行中制作（快照视图，不改状态）。 */
export function craftingProgressOf(world: GameWorld, ownerEid: number): CraftingProgress[] {
  const jobs = world.craftingJobs.get(ownerEid);
  if (!jobs || jobs.length === 0) return [];
  const tick = world.time.tick;
  return jobs.map((job) => {
    const remainingTicks = Math.max(0, job.finishTick - tick);
    return {
      recipeId: job.recipeId,
      finishTick: job.finishTick,
      remainingTicks,
      progress: job.durationTicks > 0 ? 1 - remainingTicks / job.durationTicks : 1,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 背包校验/消耗（原有逻辑不变）                                          */
/* ------------------------------------------------------------------ */

/** 背包中 recipe 每种 input 的数量是否都 ≥ 需求（跨槽合计）。 */
function hasMaterials(inv: NonNullable<(typeof Inventory)[number]>, recipe: CraftingRecipe): boolean {
  for (const input of recipe.inputs) {
    let total = 0;
    for (const s of inv.slots) {
      if (s && s.kind === input.kind) total += s.count;
    }
    if (total < input.count) return false;
  }
  return true;
}

/** dry-run：克隆槽位模拟全部 output 入包，任一放不下则拒（防消耗后满包丢产出）。 */
function outputsFit(world: GameWorld, inv: NonNullable<(typeof Inventory)[number]>, recipe: CraftingRecipe): boolean {
  const dryInv = {
    capacity: inv.capacity,
    slots: inv.slots.map((s) => (s ? { ...s } : null)),
  };
  for (const out of recipe.outputs) {
    const leftover = addToInventory(dryInv, world.gameDef.itemsByKind, out.kind, out.count);
    if (leftover > 0) return false;
  }
  return true;
}

/** 跨槽贪婪消耗 inputs（调用前已通过 hasMaterials 校验，必然扣足）。 */
function consumeMaterials(inv: NonNullable<(typeof Inventory)[number]>, recipe: CraftingRecipe): void {
  for (const input of recipe.inputs) {
    let remaining = input.count;
    for (let i = 0; i < inv.slots.length && remaining > 0; i++) {
      const s = inv.slots[i];
      if (!s || s.kind !== input.kind) continue;
      const take = Math.min(remaining, s.count);
      s.count -= take;
      remaining -= take;
      if (s.count <= 0) inv.slots[i] = null;
    }
  }
}
