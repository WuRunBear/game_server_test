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
 *
 * ## 派生投影（无独立 AoS 组件的同步键）
 *
 * buildSnapshot 的派生分支当前包含 `Crafting`（world.craftingJobs 任务表）与
 * `Action`（动作时间轴瞬态 ActionState），分别由 netSyncDerived 登记、在
 * GameSimulation.buildSnapshot 展平。少数跨组件的派生键仍挂在 **Kind 适配器**
 * 上输出（Kind 条目无 tags、遍历全体带 NetworkId 的实体，是唯一覆盖所有实体
 * 的适配器扩展点）：
 * - `Category.value`（string）—— 框架通用实体分类，见 categoryOf；
 * - `Projectile.ownerNetworkId`（number）—— 投射物主人的 networkId（0=无主），
 *   **绝不输出 owner eid**；
 * - `Lifetime.remainingTicks`（number）—— 持久寿命剩余 tick（绝对到期 tick
 *   − 当前 tick，≥0），不直接暴露 expiresTick；
 * - `Equipment.weaponKind/toolKind/armorKind`（string）—— 玩家三个装备槽当前
 *   物品 kind（CC-10）；只给 kind，不暴露槽位索引或其他背包内容。
 * 其余派生键（StateMachine/Modifiers/ExpiresAt）各有独立 AoS 条目。
 */
import { hasComponent } from "bitecs";
import type { GameWorld } from "world";
import {
  Kind, Needs, Inventory, ItemMeta, ResourceNode, Portal,
  Dialogue, DialogueSource, Quest, Relation, Progression,
  NetworkId, Projectile, Lifetime, Placeable, Structure, Equipment,
  Player, Enemy, NPC, Item, Resource, Container,
} from "components";
import { Achievements } from "components/achievements";
import { Ledger } from "components/ledger";
import { ExpiresAt } from "framework/simulation/timer/timer";
import { StateMachine } from "framework/simulation/stateMachine/stateMachine";
import { Modifiers } from "framework/simulation/modifiers/modifiers";
import {
  ActionState,
  getActionDefinition,
  phaseIdAt,
} from "framework/simulation/actions/actionState";

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

/**
 * 框架通用实体分类（客户端按此选渲染/交互路径，而不是用 Health+Needs 猜）。
 *
 * 只使用框架机制词与标签，不解释 game/ 的 kind 字符串：
 * - `player`：Player 标签；
 * - `enemy`：Enemy 标签（同时有 Enemy+NPC 时敌人优先）；
 * - `npc`：NPC 标签；
 * - `projectile`：Projectile 组件（投射物无原型）；
 * - `structure`：Structure 或 Placeable 组件（建造物/可放置设施）；
 * - `resource`：Resource 标签（可采集节点）；
 * - `container`：Container 标签（尸体/容器）；
 * - `item`：Item 标签（地面掉落物）；
 * - `other`：其余带 NetworkId 的实体（兜底，客户端可只画 Transform）。
 */
function categoryOf(world: GameWorld, eid: number): string {
  if (hasComponent(world, eid, Player)) return "player";
  if (hasComponent(world, eid, Enemy)) return "enemy";
  if (hasComponent(world, eid, NPC)) return "npc";
  if (hasComponent(world, eid, Projectile)) return "projectile";
  if (hasComponent(world, eid, Structure) || hasComponent(world, eid, Placeable)) return "structure";
  if (hasComponent(world, eid, Resource)) return "resource";
  if (hasComponent(world, eid, Container)) return "container";
  if (hasComponent(world, eid, Item)) return "item";
  return "other";
}

/**
 * 跨组件派生投影（挂在 Kind 适配器上输出，理由见文件头）。
 *
 * 键与语义：
 * - `Category.value`（strings）：categoryOf 的框架通用分类；
 * - `Projectile.ownerNetworkId`（values）：Projectile.owner eid → NetworkId
 *   （主人实体已销毁/无 NetworkId 时为 0），不输出 eid；
 * - `Lifetime.remainingTicks`（values）：`max(0, Lifetime.expiresTick - tick)`，
 *   客户端无需再读绝对到期 tick。
 */
function writeDerivedEntityProjections(world: GameWorld, eid: number, out: AosSyncOutput): void {
  out.strings["Category.value"] = categoryOf(world, eid);

  if (hasComponent(world, eid, Projectile)) {
    const ownerEid = Projectile.owner[eid];
    const ownerNetworkId =
      typeof ownerEid === "number" && ownerEid >= 0 && hasComponent(world, ownerEid, NetworkId)
        ? NetworkId.value[ownerEid]
        : 0;
    out.numbers["Projectile.ownerNetworkId"] = ownerNetworkId;
  }

  if (hasComponent(world, eid, Lifetime)) {
    const remaining = Lifetime.expiresTick[eid] - world.time.tick;
    out.numbers["Lifetime.remainingTicks"] = Math.max(0, remaining);
  }
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

/**
 * 内建适配器：Inventory（按槽索引展开 kind/count，空槽占位；耐久/腐烂按需）。
 *
 * `spoilAt` 输出**绝对世界 tick**（`Inventory.<i>.spoilAt`），与 `RoomState.tick`
 * 同一时间基；客户端用 `spoilAt - RoomState.tick` 换算剩余 tick。只在该槽
 * 存在绝对到期 tick 时写键（不腐烂/空槽不写 → key diff 清掉旧残留）。
 */
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
      } else if (f === "spoilAt") {
        // 绝对腐烂到期 tick（世界逻辑 tick；见上方注释）
        if (slot && typeof slot.spoilAt === "number") {
          out.numbers[`Inventory.${i}.spoilAt`] = slot.spoilAt;
        }
      }
    }
  }
  return out;
});

/**
 * 内建适配器：ItemMeta（地面 item 实体的 kind/count/耐久/腐烂）。
 *
 * `spoilAt` 语义与 Inventory 一致：**绝对世界 tick**，与 `RoomState.tick`
 * 同基；客户端自行换算 `spoilAt - RoomState.tick`。仅腐烂物品写键。
 */
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
    } else if (f === "spoilAt") {
      // 绝对腐烂到期 tick（世界逻辑 tick；见上方注释）
      if (typeof meta.spoilAt === "number") {
        out.numbers["ItemMeta.spoilAt"] = meta.spoilAt;
      }
    }
  }
  return out;
});

/**
 * 装备槽派生投影（CC-10）：只输出三个装备槽当前物品的 **kind**。
 *
 * 隐私边界：读取 `Equipment.weaponSlot/toolSlot/armorSlot` 引用的背包槽，只写
 * `Equipment.weaponKind` / `toolKind` / `armorKind` 三个字符串键；**不输出**槽位
 * 索引、数量、耐久、腐烂或其他背包槽内容。空槽/过期引用/空 kind 不写键
 * （GameRoom 的 key diff 会清掉上一帧残留）。
 *
 * 由 netSync 的 `{ component: "Kind", tags: ["Player"], fields: ["equipment"] }`
 * 条目触发——沿用 Kind 适配器这一覆盖全部实体的扩展点，不新增 EntityState
 * schema 字段。
 */
function writeEquippedKinds(world: GameWorld, eid: number, out: AosSyncOutput): void {
  if (!hasComponent(world, eid, Equipment)) return;
  const inv = Inventory[eid];
  if (!inv) return;

  const slots: ReadonlyArray<readonly [suffix: string, slotRef: number]> = [
    ["weaponKind", Equipment.weaponSlot[eid]],
    ["toolKind", Equipment.toolSlot[eid]],
    ["armorKind", Equipment.armorSlot[eid]],
  ];
  for (const [suffix, slotRef] of slots) {
    if (typeof slotRef !== "number" || slotRef < 0 || slotRef >= inv.slots.length) continue;
    const stack = inv.slots[slotRef];
    if (!stack || typeof stack.kind !== "string" || stack.kind.length === 0) continue;
    out.strings[`Equipment.${suffix}`] = stack.kind;
  }
}

/**
 * 内建适配器：Kind（原型种类字符串；客户端据此区分树/矿/狼/建筑等）。
 *
 * 同时输出跨组件派生投影（Category / Projectile.ownerNetworkId /
 * Lifetime.remainingTicks），理由与键语义见文件头与 writeDerivedEntityProjections。
 */
registerAosSyncAdapter("Kind", (world, eid, fields) => {
  const out = empty();
  writeDerivedEntityProjections(world, eid, out);
  // CC-10：装备槽 kind 派生（fields 含 "equipment" 时启用；隐私规则见函数注释）
  if (fields.includes("equipment")) writeEquippedKinds(world, eid, out);
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

/**
 * 内建适配器：Action（动作时间轴瞬态状态，fields 由 netSync 白名单控制）。
 *
 * 键与语义（全部与 `RoomState.tick` 同基，客户端只读）：
 * - `Action.actionId`（strings）：动作 id（配置字符串）；
 * - `Action.startedTick` / `Action.durationTicks`（values）：动画进度基准；
 * - `Action.phase`（strings）/ `Action.phaseIndex`（values）：当前阶段；
 * - `Action.target`（values）：目标 **networkId**（0 = 无目标，绝不输出 eid）；
 * - `Action.dirX` / `Action.dirY`（values）：朝向单位向量。
 *
 * 无动作时不写任何键；GameRoom 的 key diff 会清掉上一帧残留。目标实体已销毁/
 * 无 NetworkId 时同样不写 target 键（客户端按无目标处理）。
 */
registerAosSyncAdapter("Action", (world, eid, fields) => {
  const out = empty();
  const state = ActionState[eid];
  if (!state) return out;
  const definition = getActionDefinition(world, state.actionId);
  for (const field of fields) {
    if (field === "actionId") out.strings["Action.actionId"] = state.actionId;
    else if (field === "startedTick") out.numbers["Action.startedTick"] = state.startedTick;
    else if (field === "durationTicks") out.numbers["Action.durationTicks"] = state.durationTicks;
    else if (field === "phaseIndex") out.numbers["Action.phaseIndex"] = state.phaseIndex;
    else if (field === "phase") {
      out.strings["Action.phase"] =
        state.phase || (definition ? phaseIdAt(definition, state.phaseIndex) : "");
    } else if (field === "target") {
      // 优先动作启动时解析的 networkId（目标在 windup 内死亡/销毁也保持稳定，
      // 客户端能继续朝向原目标）；无目标写 0（与 Projectile.ownerNetworkId 同
      // 约定），绝不输出 eid。
      if (state.targetNetworkId !== undefined) {
        out.numbers["Action.target"] = state.targetNetworkId;
      } else if (state.targetEid >= 0 && hasComponent(world, state.targetEid, NetworkId)) {
        out.numbers["Action.target"] = NetworkId.value[state.targetEid];
      } else {
        out.numbers["Action.target"] = 0;
      }
    } else if (field === "dirX") out.numbers["Action.dirX"] = state.dirX;
    else if (field === "dirY") out.numbers["Action.dirY"] = state.dirY;
  }
  return out;
});

/**
 * 内建适配器：StateMachine（通用状态机当前状态，fields 需含 "state"/"stateTick"）。
 *
 * 键与语义：
 * - `StateMachine.state`（strings）：当前状态 id（配置字符串，如 alive/burning/
 *   burnt），由 stateMachineSystem 迁移；
 * - `StateMachine.stateTick`（values）：进入当前状态的**绝对 tick**
 *   （`enteredTick`，与 `RoomState.tick` 同基）——客户端用
 *   `(RoomState.tick - stateTick) / durationTicks` 算动画进度。
 *
 * 状态机是 AoS 持久组件（见 framework/simulation/stateMachine）；无数据实体不写键。
 */
registerAosSyncAdapter("StateMachine", (_world, eid, fields) => {
  const out = empty();
  const state = StateMachine[eid];
  if (!state) return out;
  for (const f of fields) {
    if (f === "state") out.strings["StateMachine.state"] = state.state;
    else if (f === "stateTick") out.numbers["StateMachine.stateTick"] = state.enteredTick;
  }
  return out;
});

/**
 * 内建适配器：Modifiers（属性修饰符的稳定投影，fields 需含 "stats"）。
 *
 * 只统计**当前生效**的条目（`expiresTick` 缺省永久；`tick >= expiresTick` 视为
 * 失效，与 computeStat 同语义），按 statKey 展开：
 * - `Modifiers.<stat>.mul`（values）—— 生效乘法修正之和（参与 `base × (1+Σmul)`）；
 * - `Modifiers.<stat>.add`（values）—— 生效加法修正之和（参与 `+ Σadd`）；
 * - `Modifiers.<stat>.count`（values）—— 生效条目数；
 * - `Modifiers.<stat>.bool`（values）—— 存在生效 bool 条目时写 1/0（bool 优先于
 *   数值，与 computeStat 一致）；
 * - `Modifiers.<stat>.expiresTick`（values）—— 生效条目中最早的绝对失效 tick
 *   （全部永久时不写）；
 * - `Modifiers.<stat>.source.<source>`（values）—— 按来源字符串计数的生效条目数
 *   （source 为配置/效果声明的字符串，框架不解释；客户端据此区分中毒/狂暴等）。
 *
 * statKey/source 是配置字符串，原样进入动态 key（不扩大 schema）。整组条目
 * 全部失效时该 stat 不写任何键（GameRoom key diff 清理旧值）。
 */
registerAosSyncAdapter("Modifiers", (world, eid, fields) => {
  const out = empty();
  if (!fields.includes("stats")) return out;
  const set = Modifiers[eid];
  if (!set) return out;
  const tick = world.time.tick;
  for (const [stat, entries] of Object.entries(set)) {
    let mul = 0;
    let add = 0;
    let count = 0;
    let hasBool = false;
    let boolOr = false;
    let earliestExpiry = Infinity;
    const sourceCounts: Record<string, number> = {};
    for (const entry of entries) {
      if (entry.expiresTick !== undefined && tick >= entry.expiresTick) continue;
      count += 1;
      if (entry.bool !== undefined) {
        hasBool = true;
        boolOr = boolOr || entry.bool;
      } else {
        mul += entry.mul ?? 0;
        add += entry.add ?? 0;
      }
      if (entry.expiresTick !== undefined) {
        earliestExpiry = Math.min(earliestExpiry, entry.expiresTick);
      }
      if (entry.source) {
        sourceCounts[entry.source] = (sourceCounts[entry.source] ?? 0) + 1;
      }
    }
    if (count === 0) continue;
    out.numbers[`Modifiers.${stat}.mul`] = mul;
    out.numbers[`Modifiers.${stat}.add`] = add;
    out.numbers[`Modifiers.${stat}.count`] = count;
    if (hasBool) out.numbers[`Modifiers.${stat}.bool`] = boolOr ? 1 : 0;
    if (earliestExpiry !== Infinity) out.numbers[`Modifiers.${stat}.expiresTick`] = earliestExpiry;
    for (const [source, n] of Object.entries(sourceCounts)) {
      out.numbers[`Modifiers.${stat}.source.${source}`] = n;
    }
  }
  return out;
});

/**
 * 内建适配器：ExpiresAt（一次性定时器剩余时间，fields 需含 "remainingTicks"）。
 *
 * `ExpiresAt.remainingTicks` = `max(0, expiresTick - world.time.tick)`。条目本身
 * 含 EffectSpec（可能引用 eid），只输出剩余 tick，**不输出效果参数**。
 */
registerAosSyncAdapter("ExpiresAt", (world, eid, fields) => {
  const out = empty();
  if (!fields.includes("remainingTicks")) return out;
  const entry = ExpiresAt[eid];
  if (!entry) return out;
  out.numbers["ExpiresAt.remainingTicks"] = Math.max(0, entry.expiresTick - world.time.tick);
  return out;
});