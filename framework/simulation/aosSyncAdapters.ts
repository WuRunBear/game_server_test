/**
 * AoS 组件的网络同步适配器注册表。
 *
 * AoS 组件是普通 JS 数组（按 eid 索引），不走 bitecs 的 SoA 数值数组路径，
 * 无法被 bitecs query 选中。netSync 构建快照时（GameSimulation.buildSnapshot）
 * 对每个 AoS 组件条目调用本模块注册的适配器，把实体的 AoS 数据按字段白名单
 * 展平为 `{ numbers, strings }` 两个扁平 map，再合并进 EntitySnapshot。
 *
 * 与组件注册表的 AoS 初始化钩子（registerAosInitializer）互补：
 * 初始化钩子负责**写入**（spawn 实体时按原型配置写数据），
 * 这里的同步适配器负责**读出**（每帧同步时展平推送）。扩展 AoS 组件时需两者都注册。
 */
import type { GameWorld } from "world";
import {
  Kind, Needs, Inventory, ItemMeta, ResourceNode, Portal,
  Dialogue, DialogueSource, Quest, Relation, Progression,
} from "components";
import { Achievements } from "components/achievements";
import { Ledger } from "components/ledger";

/**
 * AoS 适配器的展平输出——纯数据，无 ECS 引用。
 *
 * key 形态：`<Component>.<index?>.<field>`，索引位置稳定（容量内全发，空槽用占位值），
 * 便于客户端按前缀分组渲染。游戏无关——适配器只读通用结构字段。
 */
export interface AosSyncOutput {
  /** 数值字段（如 current/max/count），写入 EntitySnapshot.values。 */
  numbers: Record<string, number>;
  /** 字符串字段（如 kind/name/treeId），写入 EntitySnapshot.strings。 */
  strings: Record<string, string>;
}

/**
 * 适配器签名：读 eid 实体的 AoS 数据，按 fields 白名单展开为纯数据。
 * @param world ECS world（当前内建适配器未使用，保留以备扩展需要）
 * @param eid 实体 id
 * @param fields netSync 配置的字段白名单（如 ["current", "max"]）
 */
export type AosSyncAdapter = (world: GameWorld, eid: number, fields: readonly string[]) => AosSyncOutput;

/** 注册表：组件名 → 适配器（bootstrap 时由内建注册表填充，扩展组件可自注册）。 */
const adapters = new Map<string, AosSyncAdapter>();

/** 注册 AoS 同步适配器（重复注册覆盖同名旧适配器）。 */
export function registerAosSyncAdapter(name: string, adapter: AosSyncAdapter): void {
  adapters.set(name, adapter);
}

/** 按组件名取适配器；未注册返回 undefined（buildSnapshot 会跳过该 netSync 条目）。 */
export function getAosSyncAdapter(name: string): AosSyncAdapter | undefined {
  return adapters.get(name);
}

/** 空输出占位：组件数据缺失时返回，避免调用方重复判空。 */
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

/** 内建适配器：Inventory（按槽索引展开 kind/count，空槽占位；耐久按需）。 */
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
      } else if (f === "durability") {
        // 仅逐实例有耐久的槽位写键（无耐久的物品不增加载荷）；
        // 空槽/无耐久槽不写 → GameRoom 的 key diff 会清掉上一帧残留
        if (slot && typeof slot.durability === "number") {
          out.numbers[`Inventory.${i}.durability`] = slot.durability;
        }
      }
    }
  }
  return out;
});

/** 内建适配器：ItemMeta（地面 item 实体的 kind/count/耐久）。 */
registerAosSyncAdapter("ItemMeta", (_world, eid, fields) => {
  const out = empty();
  const meta = ItemMeta[eid];
  if (!meta) return out;
  for (const f of fields) {
    if (f === "kind") out.strings["ItemMeta.kind"] = meta.kind;
    else if (f === "count") out.numbers["ItemMeta.count"] = meta.count;
    else if (f === "durability") {
      // 无耐久掉落物不写该键（与 Inventory 槽位同一最载荷规则）
      if (typeof meta.durability === "number") {
        out.numbers["ItemMeta.durability"] = meta.durability;
      }
    }
  }
  return out;
});

/** 内建适配器：Kind（原型种类字符串；客户端据此区分树/矿/狼/建筑等）。 */
registerAosSyncAdapter("Kind", (_world, eid, fields) => {
  const out = empty();
  const kind = Kind[eid];
  if (kind && fields.includes("value")) out.strings["Kind.value"] = kind;
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
    else if (f === "infinite") out.numbers["ResourceNode.infinite"] = state.infinite ? 1 : 0;
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

/** 内建适配器：Dialogue（玩家对话会话——npcId/树/节点/正文/选项文本）。
 *
 * 展平键（服务端权威，客户端只读）：
 * - `Dialogue.npcId`（数值）、`Dialogue.treeId` / `Dialogue.nodeId`（字符串）；
 * - `Dialogue.text`（字符串）——当前对话节点的**正文**（对话树节点的 text）；
 * - `Dialogue.option.{i}.text`（字符串）——第 i 个选项的**文案**；
 * - `Dialogue.{i}.option`（字符串，历史键）——第 i 个选项文本（旧客户端读取路径，
 *   与新键同值，保留以兼容既有客户端）。
 *
 * 字段白名单（netSync.fields）语义：
 * - `text` → 节点正文；
 * - `optionText` → 选项文案（新键 `Dialogue.option.{i}.text`）；
 * - `options` → 选项文本（旧键 `Dialogue.{i}.option`）。
 */
registerAosSyncAdapter("Dialogue", (_world, eid, fields) => {
  const out = empty();
  const state = Dialogue[eid];
  if (!state) return out;
  for (const f of fields) {
    if (f === "npcId") out.numbers["Dialogue.npcId"] = state.npcId;
    else if (f === "treeId") out.strings["Dialogue.treeId"] = state.treeId;
    else if (f === "nodeId") out.strings["Dialogue.nodeId"] = state.nodeId;
    else if (f === "text") out.strings["Dialogue.text"] = state.text ?? "";
    else if (f === "optionText") {
      for (let i = 0; i < state.options.length; i++) {
        out.strings[`Dialogue.option.${i}.text`] = state.options[i];
      }
    } else if (f === "options") {
      for (let i = 0; i < state.options.length; i++) {
        out.strings[`Dialogue.${i}.option`] = state.options[i];
      }
    }
  }
  return out;
});

/** 内建适配器：DialogueSource（NPC 对话树引用）。 */
registerAosSyncAdapter("DialogueSource", (_world, eid, fields) => {
  const out = empty();
  const state = DialogueSource[eid];
  if (!state) return out;
  for (const f of fields) {
    if (f === "treeId") out.strings["DialogueSource.treeId"] = state.treeId;
  }
  return out;
});

/** 内建适配器：Quest（任务状态按索引展开 questId/state/count）。 */
registerAosSyncAdapter("Quest", (_world, eid, fields) => {
  const out = empty();
  const quests = Quest[eid];
  if (!quests) return out;
  for (let i = 0; i < quests.length; i++) {
    const q = quests[i];
    for (const f of fields) {
      if (f === "questId") out.strings[`Quest.${i}.questId`] = q.questId;
      else if (f === "state") out.numbers[`Quest.${i}.state`] = q.state;
      else if (f === "count") out.numbers[`Quest.${i}.count`] = q.count;
    }
  }
  return out;
});

/** 内建适配器：Relation（好感按索引展开 npcKind/value）。 */
registerAosSyncAdapter("Relation", (_world, eid, fields) => {
  const out = empty();
  const relations = Relation[eid];
  if (!relations) return out;
  for (let i = 0; i < relations.length; i++) {
    const r = relations[i];
    for (const f of fields) {
      if (f === "npcKind") out.strings[`Relation.${i}.npcKind`] = r.npcKind;
      else if (f === "value") out.numbers[`Relation.${i}.value`] = r.value;
    }
  }
  return out;
});

/** 内建适配器：Progression（累计经验/等级 + 技能表按 skillId 展平）。
 *
 * 展平键（服务端权威，客户端只读）：
 * - `Progression.totalXp` / `Progression.level`：角色累计经验与派生等级；
 * - `Progression.skill.<skillId>.xp` / `.level`：按配置技能 id 展开（id 由
 *   game/ 配置约定，框架不解释其语义）。
 *
 * 技能 id 是字符串键，直接进动态 values/strings map——不扩大 PlayerState
 * schema（无协议字段索引变更），客户端按前缀 `Progression.skill.` 分组。
 */
registerAosSyncAdapter("Progression", (_world, eid, fields) => {
  const out = empty();
  const progress = Progression[eid];
  if (!progress) return out;
  for (const f of fields) {
    if (f === "totalXp") out.numbers["Progression.totalXp"] = progress.totalXp;
    else if (f === "level") out.numbers["Progression.level"] = progress.level;
    else if (f === "skills") {
      for (const [skillId, skill] of Object.entries(progress.skills)) {
        out.numbers[`Progression.skill.${skillId}.xp`] = skill.xp;
        out.numbers[`Progression.skill.${skillId}.level`] = skill.level;
      }
    }
  }
  return out;
});

/** 内建适配器：Achievements（解锁集合按成就 id 展平为 1）。
 *
 * 键形态 `Achievements.<achievementId>`（数值 1）——与 Ledger 的动态 key
 * 约定一致；客户端按前缀枚举已解锁成就。无 PlayerState schema 字段变更。
 */
registerAosSyncAdapter("Achievements", (_world, eid, fields) => {
  const out = empty();
  const state = Achievements[eid];
  if (!state) return out;
  for (const f of fields) {
    if (f !== "unlocked") continue;
    for (const [id, flag] of Object.entries(state.unlocked)) {
      out.numbers[`Achievements.${id}`] = flag;
    }
  }
  return out;
});

/** 内建适配器：Ledger（账本条目按 kind 展开——fields 白名单需含 "entries"）。 */
registerAosSyncAdapter("Ledger", (_world, eid, fields) => {
  const out = empty();
  const record = Ledger[eid];
  if (!record) return out;
  for (const [kind, count] of Object.entries(record)) {
    for (const f of fields) {
      if (f === "entries") out.numbers[`Ledger.${kind}`] = count;
    }
  }
  return out;
});