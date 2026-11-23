/**
 * CC-14 固定步长 accumulator 测试（GameRoom.onTick）。
 *
 * 采用**严格 accumulator** 策略（与 GameRoom.onTick 注释一致）：
 * - 每次回调按实际流逝时间累加，满 fixedDtMs 才推进（每步 dt 恒为 fixedDtMs）；
 * - 不足一个步长时保留余量并直接返回：不推进、不写 RoomState、不发事件；
 * - 单次回调最多 MAX_SIM_STEPS_PER_TICK 步，超出丢弃余量并 console.warn；
 * - 多步只 apply 最后一步快照，各步客户端事件按会话合并后一次发送；
 * - 调试碰撞推送仍按实际流逝时间（而非仿真步数）节流。
 *
 * 因此 dt=25ms 连续两次不是「两次各 1 步」，而是「第一次 0 步（余 25ms）、
 * 第二次 1 步（余量清零）」——仿真速度严格 = 墙钟 / fixedDtMs。
 */
import { describe, expect, it, vi } from "vitest";
import type { Client } from "@colyseus/core";

import { GameRoom, MAX_SIM_STEPS_PER_TICK } from "network/colyseus/rooms/GameRoom";
import { RoomState } from "network/colyseus/state/RoomState";
import type { ClientEvent } from "simulation/clientEvents";
import type { SimulationPort, TickResult } from "simulation";

/** 记录 send 的 mock 客户端。 */
type FakeClient = {
  sessionId: string;
  sent: Array<{ type: string; payload: unknown }>;
  send: (type: string, payload: unknown) => void;
};

function makeClient(sessionId: string): FakeClient {
  const sent: Array<{ type: string; payload: unknown }> = [];
  return {
    sessionId,
    sent,
    send(type, payload) {
      sent.push({ type, payload });
    },
  };
}

/** 造一条最小 TickResult（空实体/空兴趣；可选 per-session 事件）。 */
function makeResult(
  tick: number,
  clientEvents: Map<string, ClientEvent[]> = new Map(),
): TickResult {
  return {
    snapshot: {
      tick,
      entities: new Map(),
      offers: [],
      playerMaps: new Map(),
    },
    tickMs: 0,
    tick,
    avgTickMs: 0,
    interest: new Map(),
    clientEvents,
  };
}

/**
 * 造一个按调用次数自增 tick 的 fake sim，记录每次收到的 dt。
 *
 * `eventsAt(step, tick)` 可为第 step 步（1-based）返回该步的 per-session 事件。
 */
function makeFakeSim(
  eventsAt?: (step: number, tick: number) => Map<string, ClientEvent[]>,
): SimulationPort & { calls: number[] } {
  const calls: number[] = [];
  let tick = 0;
  let step = 0;
  const sim = {
    calls,
    tick(dtMs: number): TickResult {
      calls.push(dtMs);
      tick += 1;
      step += 1;
      return makeResult(tick, eventsAt?.(step, tick) ?? new Map());
    },
  };
  return sim as unknown as SimulationPort & { calls: number[] };
}

type GameRoomTestAccess = {
  sim: SimulationPort;
  fixedDtMs: number;
  accumulatorMs: number;
  onTick: (deltaTimeMs: number, fixedDtMs: number) => void;
  pushCollisionDebugSnapshots: (deltaTimeMs: number) => void;
};

function reach(room: GameRoom): GameRoomTestAccess {
  return room as unknown as GameRoomTestAccess;
}

function makeRoom(
  sim: SimulationPort,
  clients: FakeClient[] = [],
): GameRoom {
  const room = new GameRoom();
  room.state = new RoomState();
  reach(room).sim = sim;
  room.clients.push(...(clients as unknown as Client[]));
  return room;
}

function ev(seq: number): ClientEvent {
  return { seq, tick: seq, type: "hit", data: { attacker: 1, target: 2 } };
}

describe("GameRoom 固定步长 accumulator", () => {
  it("sim.tick 收到的 dt 恒为 fixedDtMs（实际 delta 只进 accumulator）", () => {
    const sim = makeFakeSim();
    const room = makeRoom(sim);
    const access = reach(room);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const delta of [0, -10, 10, 25, 49, 50, 51, 75, 120, 500]) {
      access.onTick(delta, 50);
    }

    expect(sim.calls.length).toBeGreaterThan(0);
    expect(sim.calls.every((dt) => dt === 50)).toBe(true);
    warn.mockRestore();
  });

  it("严格 accumulator：dt=25ms 连续两次 → 第一次 0 步（RoomState 不变）、第二次 1 步", () => {
    const sim = makeFakeSim();
    const room = makeRoom(sim);
    const access = reach(room);

    // 第一次：不足一步 → 不推进、不 applySnapshot、不发事件；余量保留
    access.onTick(25, 50);
    expect(sim.calls).toHaveLength(0);
    expect(access.accumulatorMs).toBe(25);
    expect(room.state.tick).toBe(0);
    expect(room.state.serverTimeMs).toBe(0);

    // 第二次：25 + 25 = 50 → 1 步；tick/逻辑时间同步推进
    access.onTick(25, 50);
    expect(sim.calls).toHaveLength(1);
    expect(access.accumulatorMs).toBe(0);
    expect(room.state.tick).toBe(1);
    expect(room.state.serverTimeMs).toBe(50);
  });

  it("tick 增长与 accumulator 对齐（满步消费、余量跨回调保留）", () => {
    const sim = makeFakeSim();
    const room = makeRoom(sim);
    const access = reach(room);

    // 25 < 50：0 步，余 25
    access.onTick(25, 50);
    expect(sim.calls).toHaveLength(0);
    expect(access.accumulatorMs).toBe(25);

    // 25 + 75 = 100：2 步，余 0
    access.onTick(75, 50);
    expect(sim.calls).toHaveLength(2);
    expect(access.accumulatorMs).toBe(0);

    // 120：2 步，余 20
    access.onTick(120, 50);
    expect(sim.calls).toHaveLength(4);
    expect(access.accumulatorMs).toBe(20);

    // 20 + 30 = 50：1 步，余 0
    access.onTick(30, 50);
    expect(sim.calls).toHaveLength(5);
    expect(access.accumulatorMs).toBe(0);

    // 10：0 步，余 10
    access.onTick(10, 50);
    expect(sim.calls).toHaveLength(5);
    expect(access.accumulatorMs).toBe(10);
  });

  it("回调持续早触发时 tick 增长率 ≤ 墙钟时间 / fixedDtMs", () => {
    const sim = makeFakeSim();
    const room = makeRoom(sim);
    const access = reach(room);

    // 40 次 × 25ms = 1000ms 墙钟；严格 accumulator 下最多 1000/50 = 20 步
    for (let i = 0; i < 40; i += 1) access.onTick(25, 50);

    expect(sim.calls).toHaveLength(20);
    expect(sim.calls.length).toBeLessThanOrEqual(Math.floor(1000 / 50));
    expect(room.state.tick).toBe(20);
    expect(room.state.serverTimeMs).toBe(1000);
    expect(access.accumulatorMs).toBe(0);
  });

  it("dt=500ms → 最多 MAX_SIM_STEPS_PER_TICK 步；丢弃剩余余量并 warn", () => {
    const sim = makeFakeSim();
    const room = makeRoom(sim);
    const access = reach(room);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    access.onTick(500, 50);

    expect(MAX_SIM_STEPS_PER_TICK).toBe(5);
    expect(sim.calls).toHaveLength(MAX_SIM_STEPS_PER_TICK);
    expect(access.accumulatorMs).toBe(0);
    // 500 - 5×50 = 250ms 被丢弃
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("固定步长积压超限"),
      expect.objectContaining({
        elapsedMs: 500,
        fixedDtMs: 50,
        steps: MAX_SIM_STEPS_PER_TICK,
        droppedMs: 250,
      }),
    );

    // 超限不会在下一回调继续补步：恢复为正常 1 步
    access.onTick(50, 50);
    expect(sim.calls).toHaveLength(MAX_SIM_STEPS_PER_TICK + 1);
    warn.mockRestore();
  });

  it("多步只 apply 最后快照；事件按步合并、每会话只发一条", () => {
    const eventsAt = (step: number): Map<string, ClientEvent[]> => {
      if (step === 1) {
        return new Map([
          ["s1", [ev(1)]],
          ["s2", [ev(2)]],
        ]);
      }
      if (step === 2) return new Map([["s1", [ev(3)]]]);
      return new Map([["s2", [ev(4)]]]);
    };
    const sim = makeFakeSim(eventsAt);
    const clients = [makeClient("s1"), makeClient("s2"), makeClient("s3")];
    const room = makeRoom(sim, clients);
    const access = reach(room);

    access.onTick(150, 50); // 3 步

    expect(sim.calls).toHaveLength(3);
    expect(room.state.tick).toBe(3);
    expect(room.state.serverTimeMs).toBe(150);

    // 每个有事件的会话只收到一条批量消息，顺序 = 步序（seq 单调）
    expect(clients[0]!.sent).toHaveLength(1);
    expect(clients[1]!.sent).toHaveLength(1);
    expect(clients[2]!.sent).toHaveLength(0);

    const s1Events = (clients[0]!.sent[0]!.payload as { events: ClientEvent[] }).events;
    const s2Events = (clients[1]!.sent[0]!.payload as { events: ClientEvent[] }).events;
    expect(s1Events.map((event) => event.seq)).toEqual([1, 3]);
    expect(s2Events.map((event) => event.seq)).toEqual([2, 4]);
    expect(clients[0]!.sent[0]!.type).toBe("events");
    expect(clients[1]!.sent[0]!.type).toBe("events");
  });

  it("调试碰撞推送按实际流逝时间节流；0 步回调不推送", () => {
    const sim = makeFakeSim();
    const room = makeRoom(sim);
    const access = reach(room);
    const push = vi.fn();
    access.pushCollisionDebugSnapshots = push;

    access.onTick(120, 50); // 2 步
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenLastCalledWith(120);

    // delta<=0：按 fixedDtMs 兜底（保持旧行为）
    access.onTick(0, 50);
    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenLastCalledWith(50);

    // 不足一步：不推进、不推送
    access.onTick(25, 50);
    expect(push).toHaveBeenCalledTimes(2);
  });
});
