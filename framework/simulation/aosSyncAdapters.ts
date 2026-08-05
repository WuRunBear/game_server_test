import type { GameWorld } from "world";
import {
  Needs, Inventory, ItemMeta, ResourceNode, Portal,
} from "components";

/**
 * AoS 组件的网络同步适配器。
 *
 * AoS 组件（普通 JS 数组）不能走 buildSnapshot 的 SoA `comp[field][eid]` 读路径，
 * 也无法被 bitecs query 选中；改由适配器把实体的 AoS 数据展平为
 * `{ numbers, strings }` 两个扁平 map，供 netSync 按 key 推送。
 *
 * - numbers：数值字段（写入 EntityState.values）
 * - strings：字符串字段（写入 EntityState.stringValues）
 *
 * key 形态：`<Component>.<index?>.<field>`，索引位置稳定（容量内全发，空槽用占位值），
 * 便于客户端按前缀分组渲染。游戏无关——适配器只读通用结构字段。
 */
export interface AosSyncOutput {
  numbers: Record<string, number>;
  strings: Record<string, string>;
}

export type AosSyncAdapter = (world: GameWorld, eid: number, fields: readonly string[]) => AosSyncOutput;

const adapters = new Map<string, AosSyncAdapter>();

export function registerAosSyncAdapter(name: string, adapter: AosSyncAdapter): void {
  adapters.set(name, adapter);
}

export function getAosSyncAdapter(name: string): AosSyncAdapter | undefined {
  return adapters.get(name);
}

function empty(): AosSyncOutput {
  return { numbers: {}, strings: {} };
}

/** 内建适配器：Needs（按索引展开 name/current/max）。 */
registerAosSyncAdapter("Needs", (_world, eid, fields) => {
  const out = empty();
  const needs = Needs[eid];
  if (!needs) return out;
  for (let i = 0; i < needs.length; i++) {
    const need = needs[i];
    for (const f of fields) {
      if (f === "name") out.strings[`Needs.${i}.name`] = need.name;
      else if (f === "current") out.numbers[`Needs.${i}.current`] = need.current;
      else if (f === "max") out.numbers[`Needs.${i}.max`] = need.max;
      else if (f === "decayPerSec") out.numbers[`Needs.${i}.decayPerSec`] = need.decayPerSec;
    }
  }
  return out;
});

/** 内建适配器：Inventory（按槽索引展开 kind/count，空槽占位）。 */
registerAosSyncAdapter("Inventory", (_world, eid, fields) => {
  const out = empty();
  const inv = Inventory[eid];
  if (!inv) return out;
  for (let i = 0; i < inv.capacity; i++) {
    const slot = inv.slots[i] ?? null;
    for (const f of fields) {
      if (f === "slots") {
        out.strings[`Inventory.${i}.kind`] = slot ? slot.kind : "";
        out.numbers[`Inventory.${i}.count`] = slot ? slot.count : 0;
      }
    }
  }
  return out;
});

/** 内建适配器：ItemMeta（地面 item 实体的 kind/count）。 */
registerAosSyncAdapter("ItemMeta", (_world, eid, fields) => {
  const out = empty();
  const meta = ItemMeta[eid];
  if (!meta) return out;
  for (const f of fields) {
    if (f === "kind") out.strings["ItemMeta.kind"] = meta.kind;
    else if (f === "count") out.numbers["ItemMeta.count"] = meta.count;
  }
  return out;
});

/** 内建适配器：ResourceNode（剩余量 / 上限 / 产出 kind 等）。 */
registerAosSyncAdapter("ResourceNode", (_world, eid, fields) => {
  const out = empty();
  const state = ResourceNode[eid];
  if (!state) return out;
  for (const f of fields) {
    if (f === "remaining") out.numbers["ResourceNode.remaining"] = state.remaining;
    else if (f === "max") out.numbers["ResourceNode.max"] = state.max;
    else if (f === "yieldsKind") out.strings["ResourceNode.yieldsKind"] = state.yieldsKind;
  }
  return out;
});

/** 内建适配器：Portal（目标地图 id + 传送目标坐标）。 */
registerAosSyncAdapter("Portal", (_world, eid, fields) => {
  const out = empty();
  const state = Portal[eid];
  if (!state) return out;
  for (const f of fields) {
    if (f === "targetMap") out.strings["Portal.targetMap"] = state.targetMap;
    else if (f === "x") out.numbers["Portal.x"] = state.x;
    else if (f === "y") out.numbers["Portal.y"] = state.y;
  }
  return out;
});