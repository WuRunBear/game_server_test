/**
 * 协议面补齐测试（客户端所需的服务端协议面）。
 *
 * 覆盖：
 * - RoomState 新字段：weatherId / phaseId / phaseProgress（环境派生，tick 纯函数）
 *   与 offers（报价摘要表）——快照 → RoomState 的映射正确；
 * - Dialogue 文案：AoS 适配器产出 `Dialogue.text`（节点正文）与
 *   `Dialogue.option.<i>.text`（选项文案），旧键 `Dialogue.<i>.option` 保留；
 * - offer 语义：条款 party 为**参与方 networkId**（客户端可见 id）——用
 *   networkId 可成交、伪造 networkId 被拒、发起方必须在条款中、对方必须在线；
 * - offers 摘要：形如 {"from","to","give","take"}，视角以发起方为基准；
 * - offers 的 per-client 过滤：非参与玩家看不到该条（Colyseus 编码层验证）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Encoder, Decoder, StateView } from "@colyseus/schema";
import { query } from "bitecs";

import {
  bootstrapFramework,
  createGameSimulation,
  loadGameDefinition,
} from "framework/index";
import { environmentAt } from "framework/simulation/worldClock";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { Inventory } from "framework/components/inventory";
import { Ledger } from "framework/components/ledger";
import { Dialogue } from "framework/components/dialogue";
import { queryContainer } from "framework/economy/container";
import { startDialogue, advanceDialogue } from "framework/systems/gameplay/dialogueSystem";
import { GameRoom } from "network/colyseus/rooms/GameRoom";
import { isPlayerCommand } from "network/colyseus/rooms/GameRoom";
import { RoomState } from "network/colyseus/state/RoomState";
import { PlayerState } from "network/colyseus/state/PlayerState";
import type { SimulationPort, TickResult } from "simulation";
import type { GameWorld } from "world";

beforeAll(() => {
  bootstrapFramework();
});

/** 取仿真内部的 GameWorld（私有访问器模式，同其他测试）。 */
function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

/**
 * 取某会话的玩家实体 eid（私有访问器）。
 *
 * 不用 `query(world, [Player])` 反查：bitecs legacy 的组件掩码是**进程级**
 * 共享的，同一进程内建第二个 world 时，旧世界的实体 eid 仍带掩码 → query 会
 * 返回上一世界的陈旧实体（测试环境的已知污染）。会话映射是精确的。
 */
function playerEidOf(sim: SimulationPort, sessionId: string): number {
  const map = (sim as unknown as { playerEidBySessionId: Map<string, number> }).playerEidBySessionId;
  const eid = map.get(sessionId);
  if (typeof eid !== "number") throw new Error(`session "${sessionId}" 未绑定玩家实体`);
  return eid;
}

/** 造一个最小 GameRoom 房间：state + 若干 mock 客户端（含 PlayerState + view 接线）。 */
function makeWiredRoom(players: Array<{ sessionId: string; networkId: number }>): {
  room: GameRoom;
  playerStates: Map<string, PlayerState>;
} {
  const room = new GameRoom();
  room.state = new RoomState();
  const playerStates = new Map<string, PlayerState>();
  for (const player of players) {
    const playerState = new PlayerState();
    playerState.sessionId = player.sessionId;
    playerState.entityId = player.networkId;
    playerState.visibleEntities.ownerSessionId = player.sessionId;
    room.state.players.set(player.sessionId, playerState);
    const view = new StateView();
    (view as unknown as { sessionId?: string }).sessionId = player.sessionId;
    view.add(playerState);
    view.add(room.state.offers);
    playerStates.set(player.sessionId, playerState);
    (room.clients as unknown as Array<{ sessionId: string; view: StateView }>).push({
      sessionId: player.sessionId,
      view,
    } as never);
  }
  return { room, playerStates };
}

/** GameRoom 私有成员访问器（applySnapshot 为私有方法）。 */
type GameRoomTestAccess = {
  sim: SimulationPort;
  applySnapshot: (result: TickResult) => void;
};

function reach(room: GameRoom): GameRoomTestAccess {
  return room as unknown as GameRoomTestAccess;
}

describe("RoomState 环境字段（weatherId / phaseId / phaseProgress）", () => {
  it("快照携带环境派生值，且与 environmentAt(world) 同源", async () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(gameDef);
    const world = simWorld(sim);

    const result = sim.tick(50);
    const env = environmentAt(world);

    expect(result.snapshot.environment).toBeDefined();
    expect(result.snapshot.environment!.weatherId).toBe(env.weatherId);
    expect(result.snapshot.environment!.phaseId).toBe(env.phaseId);
    expect(result.snapshot.environment!.phaseProgress).toBeCloseTo(env.progress, 10);
    // 配置里的相位/天气 id 是配置字符串（框架只透传）
    expect(["mild", "dry", "wet", "storm"]).toContain(result.snapshot.environment!.phaseId);
  });

  it("GameRoom.applySnapshot 把环境字段写入 RoomState（weatherId/phaseId/phaseProgress）", async () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(gameDef);
    const world = simWorld(sim);
    const { room } = makeWiredRoom([]);
    reach(room).sim = sim;

    reach(room).applySnapshot(sim.tick(50));

    const env = environmentAt(world);
    expect(room.state.weatherId).toBe(env.weatherId);
    expect(room.state.phaseId).toBe(env.phaseId);
    expect(room.state.phaseProgress).toBeCloseTo(env.progress, 10);
  });
});

describe("Dialogue 文案同步（Dialogue.text / Dialogue.option.<i>.text）", () => {
  it("打开对话写入节点正文；适配器产出 text 与 option 文案键", async () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(gameDef);
    const world = simWorld(sim);

    const join = sim.addPlayer("s1");
    const playerEid = playerEidOf(sim, "s1");

    // 造一个 NPC（对话源：villager-main 树）并与玩家同图同层、距离内
    const npcArchetype = world.archetypes.get("villager")!;
    const npcEid = (await import("framework/entities/spawn")).spawnEntity(
      world,
      npcArchetype,
      world.components_registry as never,
      { x: 16, y: 16, mapId: world.defaultMapId },
    );
    const { Transform } = await import("framework/components/transform");
    Transform.x[playerEid] = 16;
    Transform.y[playerEid] = 16;

    expect(startDialogue(world, playerEid, npcEid)).toBe(true);
    const tree = gameDef.dialoguesByKind!.get("villager-main")!;
    const node = tree.nodes[tree.start]!;

    // AoS 状态：节点正文来自对话树
    expect(Dialogue[playerEid]!.text).toBe(node.text);
    expect(Dialogue[playerEid]!.options).toEqual(node.options.map((o) => o.label));

    // 快照同步键：正文 + 选项文案（+ 旧键保留）
    const result = sim.tick(50);
    const snap = result.snapshot.entities.get(join.networkId)!;
    expect(snap.strings["Dialogue.text"]).toBe(node.text);
    expect(snap.strings["Dialogue.option.0.text"]).toBe(node.options[0]!.label);
    expect(snap.strings["Dialogue.0.option"]).toBe(node.options[0]!.label);

    // 推进到下一节点：正文与选项文案同步刷新
    expect(advanceDialogue(world, playerEid, 0)).toBe(true);
    const nextNode = tree.nodes[Dialogue[playerEid]!.nodeId]!;
    expect(Dialogue[playerEid]!.text).toBe(nextNode.text);
    const snap2 = sim.tick(50).snapshot.entities.get(join.networkId)!;
    expect(snap2.strings["Dialogue.text"]).toBe(nextNode.text);
    expect(snap2.strings["Dialogue.option.0.text"]).toBe(nextNode.options[0]!.label);
    expect(npcEid).toBeGreaterThanOrEqual(0);
  });
});

describe("offer 的 networkId 语义", () => {
  /** 造两个在线玩家（各带背包），返回 eid 与 networkId。 */
  async function twoPlayers(): Promise<{
    sim: SimulationPort;
    world: GameWorld;
    p1: number;
    p2: number;
    net1: number;
    net2: number;
  }> {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(gameDef);
    const world = simWorld(sim);
    const join1 = sim.addPlayer("s1");
    const join2 = sim.addPlayer("s2");
    const p1 = playerEidOf(sim, "s1");
    const p2 = playerEidOf(sim, "s2");
    Inventory[p1] = { capacity: 4, slots: [{ kind: "wood", count: 2 }, null, null, null] };
    Inventory[p2] = { capacity: 4, slots: [null, null, null, null] };
    Ledger[p2] = { shell: 5 };
    return { sim, world, p1, p2, net1: join1.networkId, net2: join2.networkId };
  }

  it("条款 party 用 networkId：可成交（双方确认后结算）", async () => {
    const { sim, world, net1, net2 } = await twoPlayers();

    const offered = sim.submitCommand("s1", {
      type: "offer",
      offer: [
        { party: net1, give: [{ container: "inventory", kind: "wood", count: 2 }], take: [{ container: "ledger", kind: "shell", count: 5 }] },
        { party: net2, give: [{ container: "ledger", kind: "shell", count: 5 }], take: [{ container: "inventory", kind: "wood", count: 2 }] },
      ],
    });
    expect(offered).toBe(true);

    const sessions = [...world.offerSessions.values()];
    expect(sessions.length).toBe(1);
    const session = sessions[0]!;
    expect(session.status).toBe("pending");
    // 内部条款用 eid（服务端结算语义），发起方视角正确
    expect(session.initiator).toBeGreaterThan(0);
    expect(session.terms.map((t) => t.party)).toContain(session.initiator);

    // 对方确认 → 成交
    expect(sim.submitCommand("s2", { type: "offer-accept", offerId: session.id })).toBe(true);
    expect(session.status).toBe("settled");
  });

  it("伪造 networkId（不存在/非实体）被拒；发起方不在条款中被拒", async () => {
    const { sim, world, net1, net2 } = await twoPlayers();

    // 伪造：把对方写成不存在的 networkId
    const forged = sim.submitCommand("s1", {
      type: "offer",
      offer: [
        { party: net1, give: [{ container: "inventory", kind: "wood", count: 2 }] },
        { party: 999999, take: [{ container: "inventory", kind: "wood", count: 2 }] },
      ],
    });
    expect(forged).toBe(false);
    expect(world.offerSessions.size).toBe(0);

    // 发起方不在条款中：条款两方都是**他人**（发起者必须在条款中）→ 拒绝
    const third = sim.addPlayer("s3");
    const notSelf = sim.submitCommand("s1", {
      type: "offer",
      offer: [
        { party: net2, give: [{ container: "ledger", kind: "shell", count: 1 }] },
        { party: third.networkId, take: [{ container: "inventory", kind: "wood", count: 2 }] },
      ],
    });
    expect(notSelf).toBe(false);
    expect(world.offerSessions.size).toBe(0);
  });

  it("快照里的报价摘要：from/to 为 networkId，give/take 以发起方为视角", async () => {
    const { sim, net1, net2 } = await twoPlayers();

    sim.submitCommand("s1", {
      type: "offer",
      offer: [
        { party: net1, give: [{ container: "inventory", kind: "wood", count: 2 }], take: [{ container: "ledger", kind: "shell", count: 5 }] },
        { party: net2, give: [{ container: "ledger", kind: "shell", count: 5 }], take: [{ container: "inventory", kind: "wood", count: 2 }] },
      ],
    });

    const snapshot = sim.tick(50).snapshot;
    expect(snapshot.offers).toHaveLength(1);
    const summary = snapshot.offers![0]!;
    expect(summary.from).toBe(net1);
    expect(summary.to).toBe(net2);
    expect(summary.give).toEqual([["wood", 2]]);
    expect(summary.take).toEqual([["shell", 5]]);
  });

  it("RoomState.offers 写入摘要 JSON（offerId → 摘要字符串）", async () => {
    const { sim, net1, net2 } = await twoPlayers();
    sim.submitCommand("s1", {
      type: "offer",
      offer: [
        { party: net1, give: [{ container: "inventory", kind: "wood", count: 2 }], take: [{ container: "ledger", kind: "shell", count: 5 }] },
        { party: net2, give: [{ container: "ledger", kind: "shell", count: 5 }], take: [{ container: "inventory", kind: "wood", count: 2 }] },
      ],
    });

    const { room } = makeWiredRoom([
      { sessionId: "s1", networkId: net1 },
      { sessionId: "s2", networkId: net2 },
    ]);
    reach(room).sim = sim;
    reach(room).applySnapshot(sim.tick(50));

    expect(room.state.offers.size).toBe(1);
    const [offerId, json] = [...room.state.offers.entries()][0]!;
    expect(offerId).toBe("1");
    const parsed = JSON.parse(json) as {
      from: number;
      to: number;
      give: Array<[string, number]>;
      take: Array<[string, number]>;
    };
    expect(parsed.from).toBe(net1);
    expect(parsed.to).toBe(net2);
    expect(parsed.give).toEqual([["wood", 2]]);
    expect(parsed.take).toEqual([["shell", 5]]);
  });

  it("客户端形态兼容：条款数量可省略 container（缺省 inventory）；offerId 可为数字字符串", async () => {
    const { sim, world, net1, net2, p2 } = await twoPlayers();
    // 缺省容器 = inventory → 贝壳放背包（非账本）
    Inventory[p2] = { capacity: 4, slots: [{ kind: "shell", count: 5 }, null, null, null] };

    // 客户端形态：{kind, count}（无 container）+ 对方条款镜像
    const offered = sim.submitCommand("s1", {
      type: "offer",
      offer: [
        { party: net1, give: [{ kind: "wood", count: 2 }], take: [{ kind: "shell", count: 5 }] },
        { party: net2, give: [{ kind: "shell", count: 5 }], take: [{ kind: "wood", count: 2 }] },
      ],
    });
    expect(offered).toBe(true);
    const session = [...world.offerSessions.values()][0]!;
    // 缺省容器归一为 inventory
    expect(session.terms[0]!.give![0]!.container).toBe("inventory");

    // offerId 为数字字符串（客户端直接回传报价表 map 键的字符串形态）
    expect(sim.submitCommand("s2", { type: "offer-accept", offerId: String(session.id) })).toBe(true);
    expect(session.status).toBe("settled");
    // 结算走背包容器：木头换到 5 个贝壳
    expect(queryContainer(world, { type: "inventory", eid: playerEidOf(sim, "s1") }, "shell")).toBe(5);
  });

  it("报价成交/取消后：摘要从快照与 RoomState 表中移除", async () => {
    const { sim, world, net1, net2 } = await twoPlayers();
    sim.submitCommand("s1", {
      type: "offer",
      offer: [
        { party: net1, give: [{ container: "inventory", kind: "wood", count: 2 }], take: [{ container: "ledger", kind: "shell", count: 5 }] },
        { party: net2, give: [{ container: "ledger", kind: "shell", count: 5 }], take: [{ container: "inventory", kind: "wood", count: 2 }] },
      ],
    });
    const session = [...world.offerSessions.values()][0]!;
    const { room } = makeWiredRoom([{ sessionId: "s1", networkId: net1 }]);
    reach(room).sim = sim;
    reach(room).applySnapshot(sim.tick(50));
    expect(room.state.offers.size).toBe(1);

    // 取消 → 会话作废 → 摘要消失
    expect(sim.submitCommand("s1", { type: "offer-cancel", offerId: session.id })).toBe(true);
    reach(room).applySnapshot(sim.tick(50));
    expect(sim.tick(50).snapshot.offers).toHaveLength(0);
    expect(room.state.offers.size).toBe(0);
    expect(net2).toBeGreaterThan(0);
  });
});

describe("Cooldown 同步（Cooldown.remainingMs，仅玩家）", () => {
  it("玩家实体的冷却剩余毫秒进快照；非玩家实体不同步", async () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(gameDef);
    const world = simWorld(sim);
    const join = sim.addPlayer("s1");
    const playerEid = playerEidOf(sim, "s1");

    const { Cooldown } = await import("framework/components/timer");
    Cooldown.remainingMs[playerEid] = 750;

    const snapshot = sim.tick(50).snapshot;
    // 冷却剩余毫秒随 tick 递减（服务端权威），同步值落在 (0, 写入值] 区间
    const remaining = snapshot.entities.get(join.networkId)!.values["Cooldown.remainingMs"];
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(750);

    // 标签限定：非玩家实体（带 Cooldown 的敌怪）不进快照
    const { spawnEntity } = await import("framework/entities/spawn");
    const boarEid = spawnEntity(
      world,
      world.archetypes.get("boar")!,
      world.components_registry as never,
      { x: 32, y: 32, mapId: world.defaultMapId },
    );
    Cooldown.remainingMs[boarEid] = 500;
    const boarNetworkId = NetworkId.value[boarEid]!;
    const snapshot2 = sim.tick(50).snapshot;
    expect(snapshot2.entities.get(boarNetworkId)?.values["Cooldown.remainingMs"]).toBeUndefined();
  });
});

describe("传输层命令守卫（isPlayerCommand：误拒 = 命令整条丢弃）", () => {
  it("offer 条款：container 可省略；give/take 元素仍须 kind + count", () => {
    // 客户端形态：数量条目无 container
    expect(
      isPlayerCommand({
        type: "offer",
        offer: [
          { party: 11, give: [{ kind: "wood", count: 2 }], take: [{ kind: "shell", count: 5 }] },
          { party: 12, give: [{ kind: "shell", count: 5 }], take: [{ kind: "wood", count: 2 }] },
        ],
      }),
    ).toBe(true);

    // 显式 container 仍合法
    expect(
      isPlayerCommand({
        type: "offer",
        offer: [
          { party: 11, give: [{ container: "ledger", kind: "wood", count: 2 }] },
          { party: 12, take: [{ container: "inventory", kind: "wood", count: 2 }] },
        ],
      }),
    ).toBe(true);

    // 缺 count / count 非正整数 / kind 非字符串 → 拒
    expect(isPlayerCommand({ type: "offer", offer: [{ party: 11, give: [{ kind: "wood" }] }] })).toBe(false);
    expect(isPlayerCommand({ type: "offer", offer: [{ party: 11, give: [{ kind: "wood", count: 0 }] }] })).toBe(false);
    expect(isPlayerCommand({ type: "offer", offer: [{ party: 11, give: [{ kind: "wood", count: 1.5 }] }] })).toBe(false);
    expect(isPlayerCommand({ type: "offer", offer: [{ party: 11, give: [{ kind: 7, count: 1 }] }] })).toBe(false);
    // party 必须是正整数 networkId
    expect(isPlayerCommand({ type: "offer", offer: [{ party: 0 }] })).toBe(false);
    expect(isPlayerCommand({ type: "offer", offer: [{ party: "11" }] })).toBe(false);
    // 未知 container 取值 → 拒
    expect(isPlayerCommand({ type: "offer", offer: [{ party: 11, give: [{ container: "bag", kind: "wood", count: 1 }] }] })).toBe(false);
  });

  it("offerId：数字与数字字符串皆可；非数字字符串拒", () => {
    expect(isPlayerCommand({ type: "offer-accept", offerId: 12 })).toBe(true);
    expect(isPlayerCommand({ type: "offer-accept", offerId: "12" })).toBe(true);
    expect(isPlayerCommand({ type: "offer-cancel", offerId: "12" })).toBe(true);
    expect(isPlayerCommand({ type: "offer-accept", offerId: "abc" })).toBe(false);
    expect(isPlayerCommand({ type: "offer-accept", offerId: 1.5 })).toBe(false);
  });
});

describe("传输层 → 仿真层 链路（客户端形态的报价命令不被守卫丢弃）", () => {
  it("room 的 command 处理器：container 省略 + offerId 字符串 → 报价成立并可成交", async () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(gameDef);
    const world = simWorld(sim);
    const join1 = sim.addPlayer("s1");
    const join2 = sim.addPlayer("s2");
    const p2 = playerEidOf(sim, "s2");
    Inventory[playerEidOf(sim, "s1")] = { capacity: 4, slots: [{ kind: "wood", count: 2 }, null, null, null] };
    Inventory[p2] = { capacity: 4, slots: [{ kind: "shell", count: 5 }, null, null, null] };

    const room = new GameRoom();
    room.state = new RoomState();
    reach(room).sim = sim;
    // 注册消息处理器（与 onCreate 同一路径）
    (room as unknown as { registerMessageHandlers: () => void }).registerMessageHandlers();

    // 直连传输层事件总线（Colyseus 收包时的同一入口）
    const emit = (message: unknown) =>
      (
        room as unknown as {
          onMessageEvents: { emit: (type: string, client: unknown, message: unknown) => void };
        }
      ).onMessageEvents.emit("command", { sessionId: "s1" }, message);

    // ① 客户端形态的 offer（数量无 container）
    emit({
      type: "offer",
      offer: [
        { party: join1.networkId, give: [{ kind: "wood", count: 2 }], take: [{ kind: "shell", count: 5 }] },
        { party: join2.networkId, give: [{ kind: "shell", count: 5 }], take: [{ kind: "wood", count: 2 }] },
      ],
    });
    expect(world.offerSessions.size).toBe(1);
    const session = [...world.offerSessions.values()][0]!;
    expect(session.status).toBe("pending");
    // 缺省 container 归一为 inventory
    expect(session.terms[0]!.give![0]!.container).toBe("inventory");

    // ② offerId 用字符串回传（RoomState.offers 的 map 键原值）
    (
      room as unknown as {
        onMessageEvents: { emit: (type: string, client: unknown, message: unknown) => void };
      }
    ).onMessageEvents.emit("command", { sessionId: "s2" }, {
      type: "offer-accept",
      offerId: String(session.id),
    });
    expect(session.status).toBe("settled");
  });
});

describe("offers 的 per-client 过滤（非参与玩家看不到该条）", () => {
  it("编码层：两个连接各自只收到自己参与的报价条目", () => {
    const state = new RoomState();
    const encoder = new Encoder(state);

    const viewA = new StateView();
    (viewA as unknown as { sessionId?: string }).sessionId = "s1";
    viewA.add(state);
    viewA.add(state.offers);

    const viewB = new StateView();
    (viewB as unknown as { sessionId?: string }).sessionId = "s2";
    viewB.add(state);
    viewB.add(state.offers);

    // 两条报价：1 与 s1 有关，2 与 s2 有关
    state.offers.set("1", JSON.stringify({ from: 11, to: 12, give: [["wood", 2]], take: [] }));
    state.offers.set("2", JSON.stringify({ from: 12, to: 13, give: [["shell", 5]], take: [] }));
    state.offers.setVisibleSessions("1", ["s1"]);
    state.offers.setVisibleSessions("2", ["s2"]);

    const decodeInto = (view: StateView): MapSchemaLike => {
      const bytes = encoder.encodeView(view, 1, { offset: 1 });
      const clientState = new RoomState();
      const decoder = new Decoder(clientState);
      decoder.decode(bytes.subarray(1));
      return clientState.offers as unknown as MapSchemaLike;
    };

    const seenByA = decodeInto(viewA);
    const seenByB = decodeInto(viewB);

    expect([...seenByA.keys()]).toEqual(["1"]);
    expect([...seenByB.keys()]).toEqual(["2"]);
    expect(seenByA.get("1")).toContain('"from":11');
  });

  it("删除条目：曾看到该条的连接收到删除操作（表项消失）", () => {
    const state = new RoomState();
    const encoder = new Encoder(state);
    const viewA = new StateView();
    (viewA as unknown as { sessionId?: string }).sessionId = "s1";
    viewA.add(state);
    viewA.add(state.offers);

    state.offers.set("1", JSON.stringify({ from: 11, to: 12, give: [], take: [] }));
    state.offers.setVisibleSessions("1", ["s1"]);

    const clientState = new RoomState();
    const decoder = new Decoder(clientState);
    decoder.decode(encoder.encodeView(viewA, 1, { offset: 1 }).subarray(1));
    expect(clientState.offers.size).toBe(1);

    // 删除条目（可见性登记先保留一轮，让删除操作被编码）
    state.offers.delete("1");
    decoder.decode(encoder.encodeView(viewA, 1, { offset: 1 }).subarray(1));
    expect(clientState.offers.size).toBe(0);
  });
});

/** 测试用的 MapSchema 最小形状（只断言 key/value 读取）。 */
interface MapSchemaLike {
  size: number;
  keys(): IterableIterator<string>;
  get(key: string): string | undefined;
}
