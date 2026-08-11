/**
 * Slice 7 测试：事件总线 / 对话 / 任务 / 好感 链路。
 *
 * 覆盖：帧内事件总线（emit/consume 与击杀事件）、dialogueSystem
 * （start/advance/效果执行）、questSystem（收集/击杀进度与提交）、
 * talk 意图命令路由、Quest/Relation 持久化（Dialogue 不入档），
 * 以及真实配置的对话任务线全链路。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createGameSimulation,
  createDefaultGameDefinition,
  loadGameDefinition,
  spawnEntity,
  getRegistries,
  serializeWorld,
  restoreWorld,
  emitEvent,
  consumeEvents,
  startDialogue,
  advanceDialogue,
  applyDialogueEffect,
  acceptQuest,
  submitQuest,
  createQuestSystem,
  addRelation,
  getRelation,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Velocity, Collider, ColliderShape } from "framework/components/physics";
import { Health, Attack, Team } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player, NPC } from "framework/components/tags";
import { Dialogue } from "framework/components/dialogue";
import { DialogueSource } from "framework/components/dialogueSource";
import { Quest, QUEST_ACTIVE, QUEST_READY, QUEST_DONE } from "framework/components/quest";
import { Relation } from "framework/components/relation";
import { Inventory } from "framework/components/inventory";
import { Cooldown } from "framework/components/timer";
import { Kind } from "framework/components/kind";
import { Intent } from "framework/components/intent";
import { attackTarget } from "framework/systems/gameplay/combatSystem";
import { createInteractionSystem } from "framework/systems/gameplay/interactionSystem";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import type { GameWorld } from "framework/world";
import type { DialogueTreeJson } from "framework/config/schema/DialogueSchema";
import type { QuestDefinitionJson } from "framework/config/schema/QuestSchema";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

/** 构造一个最小世界（默认配置，无依赖具体 game 配置内容）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 注册测试原型（全局注册表单例，跨用例重复注册会抛错 → 已存在则跳过）。 */
function ensureArchetype(world: GameWorld, spec: Parameters<typeof world.archetypes.register>[0]): void {
  if (!world.archetypes.has(spec.kind)) {
    world.archetypes.register(spec);
  }
}

interface PlayerOpts {
  x?: number; y?: number; hp?: number; capacity?: number;
}

function spawnTestPlayer(world: GameWorld, opts: PlayerOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  addComponent(world, eid, Team);
  addComponent(world, eid, Attack);
  addComponent(world, eid, Cooldown);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  Health.current[eid] = opts.hp ?? 100;
  Health.max[eid] = 100;
  Team.id[eid] = 1;
  Attack.value[eid] = 10;
  Attack.range[eid] = 40;
  Cooldown.remainingMs[eid] = 0;
  Inventory[eid] = {
    capacity: opts.capacity ?? 8,
    slots: Array.from({ length: opts.capacity ?? 8 }, () => null),
  };
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-player");
  // legacy AoS 数组跨 world 共享：显式清零残留，防 eid 复用污染断言
  Quest[eid] = undefined;
  Relation[eid] = undefined;
  Dialogue[eid] = undefined;
  Intent[eid] = undefined;
  return eid;
}

/** 注册可对话 NPC 原型（NPC tag + DialogueSource）+ 对话树与任务定义。 */
function setupDialogueWorld(world: GameWorld): void {
  ensureArchetype(world, {
    kind: "npc1",
    tags: ["NPC"],
    components: {
      Size: { w: 16, h: 16 },
      Collider: { shape: 1, halfW: 8, halfH: 8 },
      Health: { current: 50, max: 50 },
      DialogueSource: { treeId: "t1" },
    },
  });
  const tree: DialogueTreeJson = {
    id: "t1",
    start: "start",
    nodes: {
      start: {
        text: "hi",
        options: [
          { label: "next", to: "n1" },
          { label: "bye", to: "__end__" },
        ],
      },
      n1: {
        text: "node1",
        options: [
          { label: "accept", effect: { type: "quest_accept", questId: "q1" }, to: "n1" },
          { label: "submit", effect: { type: "quest_submit", questId: "q1" }, to: "n1" },
          { label: "thanks", effect: { type: "relation_delta", npcKind: "npc1", delta: 5 }, to: "__end__" },
        ],
      },
      n2: {
        text: "node2",
        options: [
          // 无效跳转目标：效果不应执行、会话不应关闭（配置笔误防御）
          { label: "bad-to", effect: { type: "relation_delta", npcKind: "npc1", delta: 9 }, to: "nope" },
        ],
      },
    },
  };
  world.gameDef.resolvedDialogues = [tree];
  world.gameDef.dialoguesByKind = new Map([[tree.id, tree]]);
  const quests: QuestDefinitionJson[] = [
    {
      id: "q1", type: "collect", itemKind: "m1", goal: 3,
      submit: { rewards: [{ kind: "r1", count: 1 }], relationDelta: 10 },
    },
    {
      id: "q2", type: "kill", victimKind: "victim", goal: 2,
      submit: { rewards: [], relationDelta: 5 },
    },
  ];
  world.gameDef.resolvedQuests = quests;
  world.gameDef.questsByKind = new Map(quests.map((q) => [q.id, q]));
  world.gameDef.itemsByKind!.set("m1", { kind: "m1", maxStack: 20 });
  world.gameDef.itemsByKind!.set("r1", { kind: "r1", maxStack: 20 });
}

function spawnNpc(world: GameWorld, x = 0, y = 0): number {
  return spawnEntity(world, world.archetypes.get("npc1"), getRegistries().componentRegistry, { x, y });
}

// 帧内事件总线：同类型事件一次取出并清空、其他类型保留；攻击致命一击发射 killed 事件（含击杀者/受害者/kind）
describe("Slice 7：帧内事件总线", () => {
  it("emit/consume：同类型一次取出全部并清空，其他类型保留", () => {
    const world = createBareWorld();
    emitEvent(world, "killed", { kind: "a" });
    emitEvent(world, "killed", { kind: "b" });
    emitEvent(world, "other", { x: 1 });

    const killed = consumeEvents(world, "killed");
    expect(killed.length).toBe(2);
    expect(killed.map((e) => e.data.kind)).toEqual(["a", "b"]);
    // 其他类型事件保留，可被后续消费
    expect(consumeEvents(world, "other").length).toBe(1);
    expect(consumeEvents(world, "killed").length).toBe(0);
  });

  it("attackTarget 致命一击发射 killed 事件（含击杀者/受害者/kind）", () => {
    const world = createBareWorld();
    const attacker = spawnTestPlayer(world, { x: 0, y: 0 });
    ensureArchetype(world, {
      kind: "victim",
      components: { Size: { w: 16, h: 16 }, Health: { current: 10, max: 10 } },
    });
    const victim = spawnEntity(world, world.archetypes.get("victim"), getRegistries().componentRegistry, { x: 20, y: 0 });

    expect(attackTarget(world, attacker, victim)).toBe(true);
    const killed = consumeEvents(world, "killed");
    expect(killed.length).toBe(1);
    expect(killed[0].data.killer).toBe(attacker);
    expect(killed[0].data.victim).toBe(victim);
    expect(killed[0].data.kind).toBe("victim");
  });
});

// 对话：start 打开会话、advance 跳转并执行节点效果；无树/非可对话实体/超距/死亡拒，效果失败或无效跳转停留
describe("Slice 7：dialogueSystem", () => {
  it("startDialogue：打开对话（起始节点 + 选项文本）；无树/非 NPC/超距/死亡拒", () => {
    const world = createBareWorld();
    setupDialogueWorld(world);
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    const npc = spawnNpc(world, 10, 0);

    expect(startDialogue(world, player, npc)).toBe(true);
    const dlg = Dialogue[player]!;
    expect(dlg.npcId).toBe(NetworkId.value[npc]);
    expect(dlg.nodeId).toBe("start");
    expect(dlg.options).toEqual(["next", "bye"]);

    // 已在对话中重新 start 会覆盖（重启会话）
    Dialogue[player] = undefined;

    // 无 DialogueSource 的实体（普通实体）拒
    ensureArchetype(world, { kind: "plain", components: {} });
    const plain = spawnEntity(world, world.archetypes.get("plain"), getRegistries().componentRegistry, { x: 10, y: 0 });
    expect(startDialogue(world, player, plain)).toBe(false);

    // 超距拒（talkRange 缺省 48）
    const farNpc = spawnNpc(world, 100, 0);
    expect(startDialogue(world, player, farNpc)).toBe(false);

    // 死亡玩家拒
    Health.current[player] = 0;
    expect(startDialogue(world, player, npc)).toBe(false);
  });

  it("advanceDialogue：普通跳转 / __end__ 结束 / 无效选项拒 / 效果失败停留 / 无效 to 停留", () => {
    const world = createBareWorld();
    setupDialogueWorld(world);
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    const npc = spawnNpc(world, 10, 0);
    startDialogue(world, player, npc);

    // 跳转到 n1
    expect(advanceDialogue(world, player, 0)).toBe(true);
    expect(Dialogue[player]!.nodeId).toBe("n1");

    // 无效选项（越界）拒
    expect(advanceDialogue(world, player, 9)).toBe(false);
    expect(Dialogue[player]!.nodeId).toBe("n1");

    // 效果失败停留：未接任务直接提交 → quest_submit 失败 → 停留 n1
    expect(advanceDialogue(world, player, 1)).toBe(false);
    expect(Dialogue[player]!.nodeId).toBe("n1");

    // 无效跳转目标：效果不执行、会话不关闭、停留原节点
    Dialogue[player]!.nodeId = "n2";
    Dialogue[player]!.options = ["bad-to"];
    expect(advanceDialogue(world, player, 0)).toBe(false);
    expect(Dialogue[player]!.nodeId).toBe("n2");
    expect(getRelation(world, player, "npc1")).toBe(0);

    // 无效果选项结束对话
    Dialogue[player]!.nodeId = "start";
    Dialogue[player]!.options = ["next", "bye"];
    expect(advanceDialogue(world, player, 1)).toBe(true);
    expect(Dialogue[player]).toBeUndefined();
  });

  it("效果：quest_accept 接任务 / relation_delta 好感增减", () => {
    const world = createBareWorld();
    setupDialogueWorld(world);
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    const npc = spawnNpc(world, 10, 0);
    startDialogue(world, player, npc);
    advanceDialogue(world, player, 0); // → n1

    // quest_accept
    expect(advanceDialogue(world, player, 0)).toBe(true);
    expect(Quest[player]).toEqual([{ questId: "q1", state: QUEST_ACTIVE, count: 0 }]);

    // 重复 accept 失败（效果失败停留）
    expect(advanceDialogue(world, player, 0)).toBe(false);
    expect(Dialogue[player]!.nodeId).toBe("n1");

    // relation_delta
    expect(advanceDialogue(world, player, 2)).toBe(true);
    expect(getRelation(world, player, "npc1")).toBe(5);
    expect(Dialogue[player]).toBeUndefined();
  });
});

// 任务：accept 接任务、collect 按背包计数转 READY、kill 按击杀事件计数；submit 消耗材料并发奖励与好感
describe("Slice 7：questSystem", () => {
  it("acceptQuest：成功 / 未知拒 / 重复拒", () => {
    const world = createBareWorld();
    setupDialogueWorld(world);
    const player = spawnTestPlayer(world);

    expect(acceptQuest(world, player, "q1")).toBe(true);
    expect(acceptQuest(world, player, "q1")).toBe(false);
    expect(acceptQuest(world, player, "nope")).toBe(false);
  });

  it("collect 进度：背包达标 → READY；submit 消耗材料 + 奖励 + 好感 + DONE", () => {
    const world = createBareWorld();
    setupDialogueWorld(world);
    const player = spawnTestPlayer(world);
    acceptQuest(world, player, "q1");

    // 材料不足：不 READY
    Inventory[player]!.slots[0] = { kind: "m1", count: 2 };
    createQuestSystem()(world);
    expect(Quest[player]![0].state).toBe(QUEST_ACTIVE);

    // 达标 → READY
    Inventory[player]!.slots[1] = { kind: "m1", count: 1 };
    createQuestSystem()(world);
    expect(Quest[player]![0].state).toBe(QUEST_READY);

    // 未 READY 拒（新任务直接提交）
    const player2 = spawnTestPlayer(world, { x: 100, y: 100 });
    expect(submitQuest(world, player2, "q1", "npc1")).toBe(false);

    // 材料不足拒（提交前撤走材料）零副作用
    Inventory[player]!.slots[0] = null;
    expect(submitQuest(world, player, "q1", "npc1")).toBe(false);
    expect(Quest[player]![0].state).toBe(QUEST_READY);
    expect(getRelation(world, player, "npc1")).toBe(0);

    // 材料补回 → 提交成功：消耗 goal=3 个 m1（slots[0] 扣空，slots[1] 剩 1）、奖励 r1 入包、好感 +10、DONE
    Inventory[player]!.slots[0] = { kind: "m1", count: 3 };
    expect(submitQuest(world, player, "q1", "npc1")).toBe(true);
    const remainingM1 = Inventory[player]!.slots
      .filter((s) => s?.kind === "m1")
      .reduce((n, s) => n + s!.count, 0);
    expect(remainingM1).toBe(1);
    expect(Inventory[player]!.slots.some((s) => s?.kind === "r1")).toBe(true);
    expect(getRelation(world, player, "npc1")).toBe(10);
    expect(Quest[player]![0].state).toBe(QUEST_DONE);
  });

  it("kill 进度：击杀事件计数 → READY；仅统计击杀者的击杀", () => {
    const world = createBareWorld();
    setupDialogueWorld(world);
    const player = spawnTestPlayer(world);
    const bystander = spawnTestPlayer(world, { x: 50, y: 50 });
    acceptQuest(world, player, "q2");

    // 他人击杀不计入
    emitEvent(world, "killed", { killer: bystander, victim: 99, kind: "victim" });
    createQuestSystem()(world);
    expect(Quest[player]![0].count).toBe(0);

    // 自己击杀 2 只 → READY
    emitEvent(world, "killed", { killer: player, victim: 1, kind: "victim" });
    emitEvent(world, "killed", { killer: player, victim: 2, kind: "victim" });
    createQuestSystem()(world);
    expect(Quest[player]![0].count).toBe(2);
    expect(Quest[player]![0].state).toBe(QUEST_READY);
  });
});

// 命令链路：talk 意图经 interactionSystem 路由到 startDialogue（外部输入进入世界的方式）
describe("Slice 7：命令链路（talk 意图路由）", () => {
  it("interactionSystem talk 意图路由 NPC → startDialogue", () => {
    const world = createBareWorld();
    setupDialogueWorld(world);
    const interaction = createInteractionSystem({ range: 24 });
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    spawnNpc(world, 10, 0);

    // talk 意图（applyInputs 写入语义：Intent[eid] = "talk"）
    Intent[player] = "talk";
    expect(Dialogue[player]).toBeUndefined();
    interaction(world);
    expect(Dialogue[player]).toBeTruthy();
    expect(Dialogue[player]!.options).toEqual(["next", "bye"]);
    expect(Intent[player]).toBeNull();
  });
});

// 持久化：Quest/Relation 随玩家入档恢复；会话状态 Dialogue 不入档（重启自然清空）
describe("Slice 7：持久化（Quest/Relation 入档，Dialogue 不入档）", () => {
  it("serializeWorld/restoreWorld：Quest/Relation 随玩家保留，Dialogue 跳过", () => {
    const world = createBareWorld();
    setupDialogueWorld(world);
    // 注册带 Player tag 的恢复原型（restoreWorld 按 kind 重建实体）
    ensureArchetype(world, { kind: "test-player", tags: ["Player"], components: {} });
    const player = spawnTestPlayer(world, { x: 1, y: 2 });
    acceptQuest(world, player, "q1");
    addRelation(world, player, "npc1", 7);
    Dialogue[player] = { npcId: 5, treeId: "t1", nodeId: "start", options: ["a"] };

    const record = serializeWorld(world, "s7");
    const saved = record.entities.find((e) => e.networkId === NetworkId.value[player])!;
    expect(saved.components["Quest"]).toEqual([{ questId: "q1", state: QUEST_ACTIVE, count: 0 }]);
    expect(saved.components["Relation"]).toEqual([{ npcKind: "npc1", value: 7 }]);
    expect(saved.components["Dialogue"]).toBeUndefined();

    // 模拟服务端重启：清空瞬态会话（Dialogue 不入档，恢复后自然为空）
    for (let i = 0; i < Dialogue.length; i++) Dialogue[i] = undefined;

    const world2 = createBareWorld();
    setupDialogueWorld(world2);
    restoreWorld(world2, record);
    const restored = query(world2, [Player])[0];
    expect(Quest[restored]).toEqual([{ questId: "q1", state: QUEST_ACTIVE, count: 0 }]);
    expect(Relation[restored]).toEqual([{ npcKind: "npc1", value: 7 }]);
    expect(Dialogue[restored]).toBeUndefined();
  });
  it("validateIntegrity：对话选项 to 引用不存在节点抛错（配置笔误拦截）", () => {
    expect(() => loadGameDefinition({ gameJsonPath: "tests/shim/invalid-dialogue.json" }))
      .toThrow(/references unknown node/);
  });
});

// 端到端：真实 game 配置下 对话树→任务线（收集/击杀→提交→奖励）全链路走通
describe("Slice 7：真实 game 配置集成（对话任务线全链路）", () => {
  it("talk 接任务 → 收集 → 提交 → 奖励与好感", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = createGameSimulation(def);
    const world = (sim as unknown as { world: GameWorld }).world;

    sim.addPlayer("s1");
    const playerEid = query(world, [Player])[0];
    // 初始 villager 在出生点右侧 (544,512)，把玩家放到其旁
    Transform.x[playerEid] = 544;
    Transform.y[playerEid] = 512;

    // talk 意图 → 打开 villager 对话（起始节点）；快照同步 Dialogue 展平字段
    sim.submitInput("s1", { seq: 1, moveX: 0, moveY: 0, talk: true });
    const talkResult = sim.tick(50);
    const talkSnap = talkResult.snapshot.entities.get(NetworkId.value[playerEid]);
    expect(talkSnap?.strings["Dialogue.treeId"]).toBe("villager-main");
    expect(talkSnap?.strings["Dialogue.nodeId"]).toBe("start");
    expect(talkSnap?.strings["Dialogue.0.option"]).toBe("你好，我想帮忙。");
    const dlg = Dialogue[playerEid]!;
    expect(dlg.treeId).toBe("villager-main");
    expect(dlg.nodeId).toBe("start");

    // 选"你好，我想帮忙" → tasks 节点；再接任务（选项 0）
    expect(sim.submitCommand("s1", { type: "dialogue", option: 0 })).toBe(true);
    expect(Dialogue[playerEid]!.nodeId).toBe("tasks");
    expect(sim.submitCommand("s1", { type: "dialogue", option: 0 })).toBe(true);
    expect(Quest[playerEid]).toEqual([{ questId: "collect_axe", state: QUEST_ACTIVE, count: 0 }]);

    // 接任务后快照同步 Quest 展平字段
    const questResult = sim.tick(50);
    const questSnap = questResult.snapshot.entities.get(NetworkId.value[playerEid]);
    expect(questSnap?.strings["Quest.0.questId"]).toBe("collect_axe");
    expect(questSnap?.values["Quest.0.state"]).toBe(QUEST_ACTIVE);

    // 玩家背包放入任务物品 → 下一 tick questSystem 推进 READY
    Inventory[playerEid]!.slots[0] = { kind: "axe", count: 1 };
    sim.tick(50);
    expect(Quest[playerEid]![0].state).toBe(QUEST_READY);

    // 提交任务（tasks 节点选项 1）→ 消耗斧头、奖励矛、好感 +10
    expect(sim.submitCommand("s1", { type: "dialogue", option: 1 })).toBe(true);
    expect(Quest[playerEid]![0].state).toBe(QUEST_DONE);
    // 任务物品已消耗，奖励入包
    expect(Inventory[playerEid]!.slots.every((s) => s?.kind !== "axe")).toBe(true);
    expect(Inventory[playerEid]!.slots.some((s) => s?.kind === "spear")).toBe(true);
    expect(getRelation(world, playerEid, "villager")).toBe(10);
  });
});
