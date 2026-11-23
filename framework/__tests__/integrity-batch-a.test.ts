/**
 * 完整性审计批次 A（2026-10-18）回归测试。
 *
 * 覆盖：
 * - F-01 offer 越权：非玩家/离线/发起者不在条款/结构非法一律拒绝；双在线玩家
 *   显式确认后才结算；
 * - F-02 容器取回距离/同层复核 + 对话每次推进的 NPC 可达性复核；
 * - F-03/F-04（A4）Offline 入档、旧档玩家离线保留、按 networkId 严格复用、
 *   取消 orphan FIFO；
 * - F-08 无停机存档 flushSave（可等待/幂等）；
 * - F-09 损坏存档 fail-fast（不删不覆盖）+ 无档返回 null + 原子写盘；
 * - F-43 输入严格数值校验（seq/NaN/Infinity/钳位/缺省 0）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  createGameSimulation,
  createFileRepository,
  serializeWorld,
  spawnEntity,
  startDialogue,
  advanceDialogue,
  getOffer,
  getRegistries,
} from "framework/index";
import { destroyEntity } from "framework/entities/destroyEntity";
import { createInteractionSystem } from "framework/systems/gameplay/interactionSystem";
import { Transform } from "framework/components/transform";
import { Velocity } from "framework/components/physics";
import { Health } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player, NPC } from "framework/components/tags";
import { Inventory } from "framework/components/inventory";
import { Ledger } from "framework/components/ledger";
import { Dialogue } from "framework/components/dialogue";
import { Intent } from "framework/components/intent";
import { EntityMap } from "framework/components/entityMap";
import { EntityLevel } from "framework/components/entityLevel";
import { Offline, isOfflineRetained } from "framework/components/offline";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import { GameRoom } from "framework/net/colyseus/rooms/GameRoom";
import { memoryRepository } from "./helpers/persistence";
import type { GameWorld } from "framework/world";
import type { SimulationPort } from "framework/simulation/SimulationPort";
import type { PlayerInput, TradeParty } from "framework/simulation/types";
import type { DialogueTreeJson } from "framework/config/schema/DialogueSchema";
import type { WorldRecord } from "framework/repository";

beforeAll(() => {
  bootstrapFramework();
});

/** 清空本文件涉及的 AoS 模块级单例（防跨用例 eid 复用串扰）。 */
beforeEach(() => {
  for (const arr of [Inventory, Ledger, Dialogue, Intent, EntityLevel]) {
    for (let i = 0; i < arr.length; i++) arr[i] = undefined;
  }
});

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

function eidByNetworkId(world: GameWorld, networkId: number): number | undefined {
  return [...query(world, [NetworkId])].find((eid) => NetworkId.value[eid] === networkId);
}

function emptyInventory(capacity = 4) {
  return { capacity, slots: Array.from({ length: capacity }, () => null) };
}

/** 手工生成非玩家交易/容器实体。 */
function spawnManualEntity(world: GameWorld, tags: "npc" | "player"): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Health);
  addComponent(world, eid, tags === "player" ? Player : NPC);
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  NetworkId.value[eid] = world.nextNetworkId++;
  EntityMap[eid] = world.defaultMapId;
  setEntityKind(world, eid, `batch-a-${tags}`);
  return eid;
}

/** 玩家 offer 条款（p1 给 k1 2 收 c1 6；p2 反向）。 */
function offerTerms(p1: number, p2: number): TradeParty[] {
  return [
    {
      party: p1,
      give: [{ container: "inventory", kind: "k1", count: 2 }],
      take: [{ container: "ledger", kind: "c1", count: 6 }],
    },
    {
      party: p2,
      give: [{ container: "ledger", kind: "c1", count: 6 }],
      take: [{ container: "inventory", kind: "k1", count: 2 }],
    },
  ];
}

// ─── F-01 offer 越权 ─────────────────────────────────────────────────────

describe("F-01 offer 命令：严格双人条款 + 在线玩家身份", () => {
  async function setupOfferSim() {
    const def = createDefaultGameDefinition();
    def.resolvedRules["server"] = { offlineRetentionTicks: 100 };
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);
    const nid1 = sim.addPlayer("s1").networkId;
    const nid2 = sim.addPlayer("s2").networkId;
    const p1 = eidByNetworkId(world, nid1)!;
    const p2 = eidByNetworkId(world, nid2)!;
    Inventory[p1] = emptyInventory();
    Inventory[p1].slots[0] = { kind: "k1", count: 2 };
    Ledger[p1] = {};
    Inventory[p2] = emptyInventory();
    Ledger[p2] = { c1: 6 };
    return { sim, world, p1, p2 };
  }

  it("第三方（NPC/尸体）party 被拒，不创建报价会话", async () => {
    const { sim, world, p1 } = await setupOfferSim();
    const npc = spawnManualEntity(world, "npc");
    Inventory[npc] = emptyInventory();
    Inventory[npc].slots[0] = { kind: "loot", count: 1 };

    expect(sim.submitCommand("s1", {
      type: "offer",
      offer: [
        { party: p1, give: [{ container: "inventory", kind: "k1", count: 2 }] },
        { party: npc, take: [{ container: "inventory", kind: "k1", count: 2 }] },
      ],
    }).ok).toBe(false);
    expect(world.offerSessions.size).toBe(0);
  });

  it("断线保留中的玩家 party 被拒", async () => {
    const { sim, p1, p2 } = await setupOfferSim();
    sim.removePlayer("s2"); // p2 进入 Offline 保留期

    expect(sim.submitCommand("s1", { type: "offer", offer: offerTerms(p1, p2) }).ok).toBe(false);
  });

  it("发起者不在条款中 / 重复 party / 非两方被拒", async () => {
    const { sim, world, p1, p2 } = await setupOfferSim();
    const npc = spawnManualEntity(world, "npc");

    expect(sim.submitCommand("s1", {
      type: "offer",
      offer: [
        { party: p2, give: [{ container: "ledger", kind: "c1", count: 6 }] },
        { party: npc, take: [{ container: "ledger", kind: "c1", count: 6 }] },
      ],
    }).ok).toBe(false);

    expect(sim.submitCommand("s1", {
      type: "offer",
      offer: [
        { party: p1, give: [{ container: "inventory", kind: "k1", count: 2 }] },
        { party: p1, take: [{ container: "inventory", kind: "k1", count: 2 }] },
      ],
    }).ok).toBe(false);

    expect(sim.submitCommand("s1", {
      type: "offer",
      offer: [
        { party: p1, give: [{ container: "inventory", kind: "k1", count: 2 }] },
        { party: p2, take: [{ container: "inventory", kind: "k1", count: 2 }] },
        { party: npc, take: [{ container: "inventory", kind: "k1", count: 1 }] },
      ],
    }).ok).toBe(false);
    expect(world.offerSessions.size).toBe(0);
  });

  it("条款结构非法（give/take 非数组、kind 非字符串、count 非正整数）被拒", async () => {
    const { sim, world, p1, p2 } = await setupOfferSim();
    const malformed: unknown[] = [
      [{ party: p1 }, { party: p2, give: "nope" }],
      [{ party: p1, give: [{ container: "inventory", kind: 7, count: 1 }] }, { party: p2 }],
      [{ party: p1, give: [{ container: "inventory", kind: "k1", count: 0 }] }, { party: p2 }],
      [{ party: p1, give: [{ container: "inventory", kind: "k1", count: -1 }] }, { party: p2 }],
      [{ party: p1, give: [{ container: "inventory", kind: "k1", count: 1.5 }] }, { party: p2 }],
      [{ party: "p1" }, { party: p2 }],
      null,
    ];
    for (const terms of malformed) {
      expect(sim.submitCommand("s1", { type: "offer", offer: terms as TradeParty[] }).ok).toBe(false);
    }
    expect(world.offerSessions.size).toBe(0);
  });

  it("双在线玩家：发起者自动确认、另一方必须显式 offer-accept 后才结算", async () => {
    const { sim, world, p1, p2 } = await setupOfferSim();

    expect(sim.submitCommand("s1", { type: "offer", offer: offerTerms(p1, p2) }).ok).toBe(true);
    const [session] = [...world.offerSessions.values()];
    expect(session.status).toBe("pending");
    expect(session.confirmed.has(p1)).toBe(true);
    expect(session.confirmed.has(p2)).toBe(false);

    // 未确认前资产不动
    expect(Ledger[p2]).toEqual({ c1: 6 });

    expect(sim.submitCommand("s2", { type: "offer-accept", offerId: session.id }).ok).toBe(true);
    expect(getOffer(world, session.id)!.status).toBe("settled");
    expect(Ledger[p1]).toEqual({ c1: 6 });
    expect(Inventory[p2]!.slots.map((s) => s?.kind)).toContain("k1");
  });
});

// ─── F-02 容器/对话距离复核 ──────────────────────────────────────────────

describe("F-02 容器取回：同图 + 同层 + containerRange", () => {
  async function setupLootSim() {
    const sim = await createGameSimulation(createDefaultGameDefinition());
    const world = simWorld(sim);
    const nid = sim.addPlayer("s1").networkId;
    const player = eidByNetworkId(world, nid)!;
    Inventory[player] = emptyInventory();
    const container = spawnManualEntity(world, "npc");
    Inventory[container] = emptyInventory();
    Inventory[container].slots[0] = { kind: "loot", count: 1 };
    EntityMap[container] = EntityMap[player] ?? world.defaultMapId;
    EntityLevel[player] = 0;
    EntityLevel[container] = 0;
    Transform.x[container] = Transform.x[player];
    Transform.y[container] = Transform.y[player];
    return { sim, world, player, container, networkId: NetworkId.value[container] };
  }

  it("超距 transfer 被拒；近距离可取回", async () => {
    const { sim, player, container, networkId } = await setupLootSim();

    Transform.x[container] = Transform.x[player] + 500;
    expect(sim.submitCommand("s1", { type: "transfer", target: networkId, slot: 0 }).ok).toBe(false);
    expect(Inventory[container]!.slots[0]?.count).toBe(1);

    Transform.x[container] = Transform.x[player] + 10;
    expect(sim.submitCommand("s1", { type: "transfer", target: networkId, slot: 0 }).ok).toBe(true);
    expect(Inventory[container]!.slots[0]).toBeNull();
  });

  it("隔层（同 XY 不同 level）transfer 被拒", async () => {
    const { sim, player, container, networkId } = await setupLootSim();

    Transform.x[container] = Transform.x[player] + 5;
    EntityLevel[container] = 1;
    expect(sim.submitCommand("s1", { type: "transfer", target: networkId, slot: 0 }).ok).toBe(false);
    expect(Inventory[container]!.slots[0]?.count).toBe(1);
  });
});

describe("F-02 对话推进：每次复核 NPC 存活/同图/射程", () => {
  function setupDialogueWorld(): { world: GameWorld; player: number; npc: number } {
    const world = createGameInstance(createDefaultGameDefinition()).world;
    if (!world.archetypes.has("batch-a-dialogue-npc")) {
      world.archetypes.register({
        kind: "batch-a-dialogue-npc",
        tags: ["NPC"],
        components: {
          Health: { current: 50, max: 50 },
          DialogueSource: { treeId: "batch-a-tree" },
        },
      });
    }
    const tree: DialogueTreeJson = {
      id: "batch-a-tree",
      start: "start",
      nodes: {
        start: {
          text: "hi",
          options: [
            { label: "next", to: "n1" },
            { label: "bye", to: "__end__" },
          ],
        },
        n1: { text: "n1", options: [{ label: "bye", to: "__end__" }] },
      },
    };
    world.gameDef.resolvedDialogues = [tree];
    world.gameDef.dialoguesByKind = new Map([[tree.id, tree]]);

    const player = spawnManualEntity(world, "player");
    EntityMap[player] = world.defaultMapId;
    Transform.x[player] = 0;
    Transform.y[player] = 0;
    EntityLevel[player] = 0;

    const npc = spawnEntity(
      world,
      world.archetypes.get("batch-a-dialogue-npc"),
      getRegistries().componentRegistry,
      { x: 10, y: 0 },
    );
    EntityMap[npc] = world.defaultMapId;
    EntityLevel[npc] = 0;
    return { world, player, npc };
  }

  it("近距离正常推进；走远后推进被拒且会话结束", () => {
    const { world, player, npc } = setupDialogueWorld();

    expect(startDialogue(world, player, npc)).toBe(true);
    expect(advanceDialogue(world, player, 0)).toBe(true);

    Transform.x[npc] = 5000;
    expect(advanceDialogue(world, player, 0)).toBe(false);
    expect(Dialogue[player]).toBeUndefined();
  });

  it("NPC 消失后推进被拒且会话结束", () => {
    const { world, player, npc } = setupDialogueWorld();

    expect(startDialogue(world, player, npc)).toBe(true);
    destroyEntity(world, npc);
    expect(advanceDialogue(world, player, 0)).toBe(false);
    expect(Dialogue[player]).toBeUndefined();
  });

  it("talk 半径统一为 rules/dialogue.json 的 talkRange（默认 48），不再被 interaction.range 24 屏蔽", () => {
    const { world, player, npc } = setupDialogueWorld();
    Transform.x[npc] = 30; // > interaction.range 24，< talkRange 48
    const interaction = createInteractionSystem({ range: 24 });

    Intent[player] = "talk";
    interaction(world);
    expect(Dialogue[player]).toBeDefined();
  });
});

// ─── F-09 损坏存档 ───────────────────────────────────────────────────────

describe("F-09 文件仓储：坏档 fail-fast / 无档 null / 原子写", () => {
  it("损坏 JSON：loadWorld 抛错且原文件保留；不存在返回 null；写入原子完整", async () => {
    const dir = await mkdtemp(join(tmpdir(), "batch-a-repo-"));
    try {
      const repo = createFileRepository(dir);
      expect(await repo.loadWorld("missing")).toBeNull();

      const brokenPath = join(dir, "broken.json");
      const brokenContent = '{ "id": "broken", "tick": ';
      await writeFile(brokenPath, brokenContent, "utf8");
      await expect(repo.loadWorld("broken")).rejects.toThrow(/corrupt save/);
      expect(await readFile(brokenPath, "utf8")).toBe(brokenContent);

      const record: WorldRecord = {
        id: "ok",
        savedAt: Date.now(),
        tick: 7,
        nextNetworkId: 3,
        maps: {},
        entities: [],
      };
      await repo.saveWorld(record);
      // 原子写：临时文件已被 rename 掉，目标文件是完整 JSON
      await expect(stat(`${brokenPath.replace("broken", "ok")}.tmp`)).rejects.toThrow();
      const onDisk = JSON.parse(await readFile(join(dir, "ok.json"), "utf8"));
      expect(onDisk).toEqual(record);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── F-03（A4）Offline 入档 + 身份严格复用 ───────────────────────────────

describe("A4 Offline 入档与重连身份", () => {
  /** 断线 → 存档 → 新世界恢复的公共前一步。 */
  async function recordWithDisconnectedPlayer(retentionTicks: number) {
    const def = createDefaultGameDefinition();
    def.resolvedRules["server"] = { offlineRetentionTicks: retentionTicks };
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);
    const networkId = sim.addPlayer("s1").networkId;
    sim.tick(50);
    Inventory[eidByNetworkId(world, networkId)!] = emptyInventory();
    sim.removePlayer("s1");
    const record = serializeWorld(world, "a4");
    return { def, record, networkId };
  }

  it("Offline 随档恢复：实体仍被系统/快照排除；按 networkId 重连复用", async () => {
    const { def, record, networkId } = await recordWithDisconnectedPlayer(100);
    const saved = record.entities.find((entity) => entity.networkId === networkId)!;
    expect(saved.components["Offline"]).toMatchObject({ untilTick: expect.any(Number) });

    const sim2 = await createGameSimulation(def, {
      repository: memoryRepository(record),
      saveId: "a4",
    });
    const world2 = simWorld(sim2);
    const restored = eidByNetworkId(world2, networkId)!;
    expect(isOfflineRetained(world2, restored)).toBe(true);

    const result = sim2.tick(50);
    expect(result.snapshot.entities.has(networkId)).toBe(false);

    const join = sim2.addPlayer("s2", { networkId });
    expect(join.networkId).toBe(networkId);
    expect(eidByNetworkId(world2, networkId)).toBe(restored);
    expect(isOfflineRetained(world2, restored)).toBe(false);
  });

  it("恢复后的 Offline 到期被清扫销毁", async () => {
    const { def, record, networkId } = await recordWithDisconnectedPlayer(2);
    const sim2 = await createGameSimulation(def, {
      repository: memoryRepository(record),
      saveId: "a4",
    });
    const world2 = simWorld(sim2);
    expect(eidByNetworkId(world2, networkId)).toBeDefined();

    sim2.tick(50);
    sim2.tick(50);
    expect(eidByNetworkId(world2, networkId)).toBeUndefined();
  });

  it("旧档无 Offline：玩家实体补标记为离线保留，且不被新客户端 FIFO 挪用", async () => {
    const { def, record, networkId } = await recordWithDisconnectedPlayer(100);
    const legacy: WorldRecord = structuredClone(record);
    for (const entity of legacy.entities) delete entity.components["Offline"];

    const sim2 = await createGameSimulation(def, {
      repository: memoryRepository(legacy),
      saveId: "a4",
    });
    const world2 = simWorld(sim2);
    const restored = eidByNetworkId(world2, networkId)!;
    expect(isOfflineRetained(world2, restored)).toBe(true);

    // 未出示 networkId 的新客户端：新建实体，不挪用旧玩家实体
    const join = sim2.addPlayer("new-client");
    expect(join.networkId).not.toBe(networkId);
    expect(eidByNetworkId(world2, networkId)).toBe(restored);
    expect(isOfflineRetained(world2, restored)).toBe(true);
  });
});

// ─── F-08 无停机存档 ─────────────────────────────────────────────────────

describe("F-08 flushSave：可等待、包含最新 tick、幂等", () => {
  it("flushSave 落盘最新 tick；重复调用成功；未接仓储返回 false", async () => {
    const repo = memoryRepository(null);
    const sim = await createGameSimulation(createDefaultGameDefinition(), {
      repository: repo,
      saveId: "a5",
    });
    sim.addPlayer("s1");
    sim.tick(50);
    sim.tick(50);

    expect(await sim.flushSave("test-flush")).toBe(true);
    const first = await repo.loadWorld("a5");
    expect(first!.tick).toBe(2);

    expect(await sim.flushSave("test-flush-again")).toBe(true);
    expect((await repo.loadWorld("a5"))!.tick).toBe(2);

    const bare = await createGameSimulation(createDefaultGameDefinition());
    expect(await bare.flushSave()).toBe(false);
  });

  it("GameRoom.onDispose 等待 flushSave（房间释放即落盘）", async () => {
    const room = new GameRoom();
    const flushSave = vi.fn(async () => true);
    (room as unknown as { sim: { flushSave: typeof flushSave } }).sim = { flushSave };

    await room.onDispose();
    expect(flushSave).toHaveBeenCalledWith("room-dispose");
  });
});

// ─── F-43 输入校验 ───────────────────────────────────────────────────────

describe("F-43 submitInput：严格有限数值", () => {
  async function setupInputSim() {
    const sim = await createGameSimulation(createDefaultGameDefinition());
    const world = simWorld(sim);
    const nid = sim.addPlayer("s1").networkId;
    return { sim, world, eid: eidByNetworkId(world, nid)! };
  }

  const asInput = (value: Record<string, unknown>): PlayerInput => value as unknown as PlayerInput;

  it("NaN/Infinity/非整数 seq 被拒（无 maxMoveSpeed 时也不污染 Velocity）", async () => {
    const { sim, eid } = await setupInputSim();

    sim.submitInput("s1", asInput({ seq: Number.NaN, moveX: 1, moveY: 0 }));
    sim.tick(50);
    expect(Velocity.vx[eid]).toBe(0);

    sim.submitInput("s1", asInput({ seq: 1, moveX: 1, moveY: 0 }));
    sim.submitInput("s1", asInput({ seq: 2, moveX: Number.POSITIVE_INFINITY, moveY: 0 }));
    sim.tick(50);
    expect(Velocity.vx[eid]).toBe(1); // Infinity 未覆盖上一条合法输入

    sim.submitInput("s1", asInput({ seq: 3.5, moveX: -1, moveY: 0 }));
    sim.tick(50);
    expect(Velocity.vx[eid]).toBe(0); // 无待应用输入 → 清零
  });

  it("moveX/moveY 缺失按 0；边界 ±1 通过；超大有限值被安全钳制", async () => {
    const { sim, eid } = await setupInputSim();

    sim.submitInput("s1", asInput({ seq: 1, moveX: 5, moveY: -7 }));
    sim.tick(50);
    expect(Velocity.vx[eid]).toBe(5); // px/s 协议：正常速度值原样写入
    expect(Velocity.vy[eid]).toBe(-7);

    sim.submitInput("s1", asInput({ seq: 2 }));
    sim.tick(50);
    expect(Velocity.vx[eid]).toBe(0);
    expect(Velocity.vy[eid]).toBe(0);

    sim.submitInput("s1", asInput({ seq: 3, moveX: 1, moveY: -1 }));
    sim.tick(50);
    expect(Velocity.vx[eid]).toBe(1);
    expect(Velocity.vy[eid]).toBe(-1);

    sim.submitInput("s1", asInput({ seq: 4, moveX: Number.MAX_VALUE, moveY: 0 }));
    sim.tick(50);
    expect(Velocity.vx[eid]).toBe(10_000); // 安全轴上限（防异常量级）
  });
});
