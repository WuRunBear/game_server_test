/**
 * CC-04 命令回执测试。
 *
 * - GameSimulation.submitCommand 的成功/失败错误码映射；
 * - GameRoom 的 `command-result`：requestId 原样回传、守卫失败也回执；
 * - `events` 消息批量发送（无事件不发空包）。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  bootstrapFramework,
  createGameSimulation,
  loadGameDefinition,
  type SimulationPort,
} from "framework/index";
import { Health } from "framework/components/combat";
import { Cooldown } from "framework/components/timer";
import { Equipment } from "framework/components/equipment";
import { Inventory } from "framework/components/inventory";
import { EntityMap } from "framework/components/entityMap";
import type { GameWorld } from "framework/world";
import { GameRoom } from "network/colyseus/rooms/GameRoom";
import { RoomState } from "network/colyseus/state/RoomState";
import type { ClientEvent } from "framework/simulation/clientEvents";
import type { CommandResult, TickResult } from "framework/simulation/types";

beforeAll(() => {
  bootstrapFramework();
});

beforeEach(() => {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
});

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

function playerEidOf(sim: SimulationPort, sessionId: string): number {
  const map = (sim as unknown as { playerEidBySessionId: Map<string, number> })
    .playerEidBySessionId;
  const eid = map.get(sessionId);
  if (typeof eid !== "number") throw new Error(`session "${sessionId}" 未绑定玩家实体`);
  return eid;
}

/** 载入真实 game/ 配置并覆盖 server 命令限频（避免业务用例被限流干扰）。 */
function realGameDef(maxCommandsPerSec = 100) {
  const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
  const server = def.resolvedRules["server"] as Record<string, unknown>;
  def.resolvedRules["server"] = { ...server, maxCommandsPerSec };
  return def;
}

describe("submitCommand 错误码映射", () => {
  it("成功 → {ok:true}；空槽 consume → no_item；超距 place → out_of_range", async () => {
    const sim = await createGameSimulation(realGameDef());
    const world = simWorld(sim);
    sim.addPlayer("s1");
    const p1 = playerEidOf(sim, "s1");

    Inventory[p1] = {
      capacity: 4,
      slots: [{ kind: "berry", count: 1 }, { kind: "campfire_kit", count: 1 }, null, null],
    };

    expect(sim.submitCommand("s1", { type: "consume", slot: 0 })).toEqual({ ok: true });
    expect(sim.submitCommand("s1", { type: "consume", slot: 0 })).toEqual({
      ok: false,
      code: "no_item",
    });

    const far = sim.submitCommand("s1", {
      type: "place",
      slot: 1,
      x: 10_000,
      y: 10_000,
    });
    expect(far).toEqual({ ok: false, code: "out_of_range" });
    expect(world.maps).toBeDefined();

    // 缺料：wood_axe 需要 2 wood，只有 1 → no_item。
    Inventory[p1] = { capacity: 4, slots: [{ kind: "wood", count: 1 }, null, null, null] };
    expect(sim.submitCommand("s1", { type: "craft", recipe: "wood_axe" })).toEqual({
      ok: false,
      code: "no_item",
    });
  });

  it("冷却中 throw → cooldown；死亡窗口 → dead", async () => {
    const sim = await createGameSimulation(realGameDef());
    sim.addPlayer("s1");
    const p1 = playerEidOf(sim, "s1");

    Inventory[p1] = {
      capacity: 4,
      slots: [{ kind: "throwing_spear", count: 1 }, null, null, null],
    };
    Equipment.weaponSlot[p1] = 0;
    Cooldown.remainingMs[p1] = 500;

    expect(sim.submitCommand("s1", { type: "throw", x: 10, y: 0 })).toEqual({
      ok: false,
      code: "cooldown",
    });

    Health.current[p1] = 0;
    expect(sim.submitCommand("s1", { type: "consume", slot: 0 })).toEqual({
      ok: false,
      code: "dead",
    });
  });

  it("命令频率超限 → rate_limited（同一 tick 窗口内第 2 条）", async () => {
    const sim = await createGameSimulation(realGameDef(1));
    sim.addPlayer("s1");
    const p1 = playerEidOf(sim, "s1");
    Inventory[p1] = { capacity: 4, slots: [null, null, null, null] };

    // 第 1 条放行（业务上 no_item），第 2 条在入口即被限流。
    expect(sim.submitCommand("s1", { type: "consume", slot: 0 })).toEqual({
      ok: false,
      code: "no_item",
    });
    expect(sim.submitCommand("s1", { type: "consume", slot: 0 })).toEqual({
      ok: false,
      code: "rate_limited",
    });
  });
});

/** 造一个只有 send 记录的 mock client。 */
function makeClient(sessionId: string) {
  const sent: Array<{ type: string; payload: unknown }> = [];
  return {
    sessionId,
    sent,
    send(type: string, payload: unknown) {
      sent.push({ type, payload });
    },
  };
}

function replaceSim(room: GameRoom, sim: unknown): void {
  (room as unknown as { sim: unknown }).sim = sim;
}

function roomHandlers(room: GameRoom) {
  (room as unknown as { registerMessageHandlers: () => void }).registerMessageHandlers();
  return (room as unknown as {
    onMessageEvents: { emit: (type: string, client: unknown, message: unknown) => void };
  }).onMessageEvents;
}

describe("GameRoom command-result", () => {
  it("requestId 原样回传；失败带 code；缺失 requestId 也回一条", () => {
    const room = new GameRoom();
    room.state = new RoomState();
    const calls: Array<{ command: unknown; result: CommandResult }> = [];
    replaceSim(room, {
      submitCommand(_sessionId: string, command: unknown) {
        const result: CommandResult = { ok: false, code: "no_item" };
        calls.push({ command, result });
        return result;
      },
    } as unknown as SimulationPort);
    const handlers = roomHandlers(room);
    const client = makeClient("s1");

    handlers.emit("command", client, { type: "consume", slot: 0, requestId: "req-42" });
    expect(calls).toHaveLength(1);
    expect(client.sent).toEqual([
      {
        type: "command-result",
        payload: { requestId: "req-42", type: "consume", ok: false, code: "no_item" },
      },
    ]);

    client.sent.length = 0;
    handlers.emit("command", client, { type: "consume", slot: 0 });
    expect(client.sent[0]!.payload).toMatchObject({ type: "consume", ok: false, code: "no_item" });
    expect((client.sent[0]!.payload as { requestId?: string }).requestId).toBeUndefined();
  });

  it("守卫失败（未知命令）也回 invalid，requestId 仍原样回传", () => {
    const room = new GameRoom();
    room.state = new RoomState();
    replaceSim(room, {
      submitCommand() {
        throw new Error("守卫失败不应进入仿真层");
      },
    } as unknown as SimulationPort);
    const handlers = roomHandlers(room);
    const client = makeClient("s1");

    handlers.emit("command", client, { type: "bogus", requestId: "bad-1" });
    expect(client.sent).toEqual([
      {
        type: "command-result",
        payload: { requestId: "bad-1", type: "bogus", ok: false, code: "invalid" },
      },
    ]);
  });

  it("成功也回执 {ok:true}（无 code）", () => {
    const room = new GameRoom();
    room.state = new RoomState();
    replaceSim(room, {
      submitCommand() {
        return { ok: true } satisfies CommandResult;
      },
    } as unknown as SimulationPort);
    const handlers = roomHandlers(room);
    const client = makeClient("s1");

    handlers.emit("command", client, { type: "craft", recipe: "x", requestId: "ok-1" });
    expect(client.sent).toEqual([
      {
        type: "command-result",
        payload: { requestId: "ok-1", type: "craft", ok: true },
      },
    ]);
  });
});

describe("GameRoom events 批量发送", () => {
  it("只向有事件的客户端发 {events}；无事件不发空包", () => {
    const room = new GameRoom();
    room.state = new RoomState();
    const c1 = makeClient("s1");
    const c2 = makeClient("s2");
    room.clients.push(c1 as never, c2 as never);

    const event: ClientEvent = {
      seq: 3,
      tick: 12,
      type: "hit",
      data: { attacker: 1, target: 2, damage: 4 },
    };
    const access = room as unknown as {
      sendClientEvents: (result: TickResult) => void;
    };
    access.sendClientEvents({
      clientEvents: new Map([["s1", [event]]]),
    } as unknown as TickResult);

    expect(c1.sent).toEqual([{ type: "events", payload: { events: [event] } }]);
    expect(c2.sent).toEqual([]);

    access.sendClientEvents({ clientEvents: new Map() } as unknown as TickResult);
    expect(c1.sent).toHaveLength(1);
  });
});
