import { hasComponent, query } from "bitecs";
import { CraftingStation, Inventory, Transform } from "components";
import type { GameWorld } from "world";
import { addToInventory } from "framework/systems/gameplay/inventoryOps";
import type { CraftingRecipe } from "framework/config/schema/RuleSchema";

/**
 * craftingSystem：合成原子模块（无 tick 体，命令通道驱动）。
 *
 * 服务端权威原子 `craftRecipe`：按 recipe 校验并执行「inputs 消耗 → outputs 产出」。
 * 校验顺序（任一失败即拒，且零副作用）：
 * 1. recipe 存在
 * 2. 合成者有背包
 * 3. 站点：recipe.stationType ≠ 0 时，须在 stationRange 内有匹配类型的 CraftingStation
 * 4. 缺料：背包中每种 input 的合计数量 ≥ 需求
 * 5. 满包：dry-run 克隆槽位模拟 addToInventory，全部 output 能完整放入才继续
 *
 * 成功后：跨槽贪婪消耗 inputs，产出 outputs 入包。
 * 游戏无关——kind/stationType/recipe 均为配置引用，框架不识别具体物品语义。
 */

const DEFAULT_STATION_RANGE = 64;

interface CraftingRules {
  recipes?: CraftingRecipe[];
  stationRange?: number;
}

/** 合成原子：ownerEid 按 recipeId 合成一次。返回是否成功（失败零副作用）。 */
export function craftRecipe(world: GameWorld, ownerEid: number, recipeId: string): boolean {
  const rules = world.gameDef.resolvedRules["crafting"] as CraftingRules | undefined;
  const recipe = rules?.recipes?.find((r) => r.id === recipeId);
  if (!recipe) return false;

  const inv = Inventory[ownerEid];
  if (!inv) return false;

  const stationType = recipe.stationType ?? 0;
  if (stationType !== 0) {
    const range = rules?.stationRange ?? DEFAULT_STATION_RANGE;
    if (!hasStationNearby(world, ownerEid, stationType, range)) return false;
  }

  if (!hasMaterials(inv, recipe)) return false;
  if (!outputsFit(world, inv, recipe)) return false;

  consumeMaterials(inv, recipe);
  for (const out of recipe.outputs) {
    addToInventory(inv, world.gameDef.itemsByKind, out.kind, out.count);
  }
  return true;
}

function hasStationNearby(
  world: GameWorld,
  ownerEid: number,
  stationType: number,
  range: number,
): boolean {
  if (!hasComponent(world, ownerEid, Transform)) return false;
  const ox = Transform.x[ownerEid];
  const oy = Transform.y[ownerEid];
  for (const eid of query(world, [CraftingStation, Transform])) {
    if (CraftingStation.stationType[eid] !== stationType) continue;
    const d = Math.hypot(ox - Transform.x[eid], oy - Transform.y[eid]);
    if (d <= range) return true;
  }
  return false;
}

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
