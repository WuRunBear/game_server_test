/**
 * CC-14 Network Feel 第一切片：`RoomState.serverTimeMs` + `PlayerState.lastProcessedSeq`。
 *
 * 覆盖：
 * - schema 默认值 / 字段末尾追加 / 旧索引不变（服务端 + 生成的 TS/GDScript 副本）；
 * - serverTimeMs = 逻辑 tick × fixedDtMs（多步回调也只反映最后一步；不是墙钟）；
 * - 编码往返保真；
 * - 输入 ack 语义：正常递增跟随；超速被拒不推进；乱序/重复不推进；
 * - GameRoom 每 tick 把 ack 写入对应会话的 PlayerState（per-player 隔离）。
 */
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@colyseus/core";
import { Decoder, Encoder } from "@colyseus/schema";

import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameSimulation,
} from "framework/index";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import { GameRoom } from "network/colyseus/rooms/GameRoom";
import { RoomState } from "network/colyseus/state/RoomState";
import { PlayerState } from "network/colyseus/state/PlayerState";
import { PROTOCOL_VERSION } from "network/protocol";
import type { SimulationPort, TickResult } from "simulation";

beforeAll(() => {
  bootstrapFramework();
});

/** 带移动速度上限的测试定义（用于让超速输入被仿真层拒绝）。 */
function defWithMoveLimit(maxMoveSpeed: number): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.resolvedRules["server"] = {
    ...(def.resolvedRules["server"] ?? {}),
    maxMoveSpeed,
  };
  return def;
}

type FakeClient = {
  sessionId: string;
  view?: unknown;
  send: (type: string, payload: unknown) => void;
};

function makeClient(sessionId: string): FakeClient {
  return { sessionId, send: () => {} };
}

type GameRoomTestAccess = {
  sim: SimulationPort;
  accumulatorMs: number;
  onTick: (deltaTimeMs: number, fixedDtMs: number) => void;
  applySnapshot: (result: TickResult, stepMs?: number) => void;
};

function reach(room: GameRoom): GameRoomTestAccess {
  return room as unknown as GameRoomTestAccess;
}

function makeRoom(sim: SimulationPort): GameRoom {
  const room = new GameRoom();
  room.state = new RoomState();
  reach(room).sim = sim;
  return room;
}

function joinRoom(room: GameRoom, client: FakeClient): void {
  room.clients.push(client as unknown as Client);
  room.onJoin(client as unknown as Client, { protocolVersion: PROTOCOL_VERSION });
}

/** 抽取源码中某类块内按声明顺序的 `类型:字段名` 列表（只取 @type 修饰的字段）。 */
function schemaFields(source: string, className: string): string[] {
  const start = source.indexOf(`export class ${className}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("export class", start + 1);
  const block = source.slice(start, next < 0 ? undefined : next);
  const fields: string[] = [];
  for (const match of block.matchAll(/@type\((.+?)\)\s*(?:public\s+)?(\w+)\s*[:=!]/g)) {
    fields.push(`${match[1]!.trim()}:${match[2]}`);
  }
  return fields;
}

// ─── schema 形状 ─────────────────────────────────────────────────────────

describe("CC-14 schema 字段", () => {
  it("默认值：serverTimeMs=0、lastProcessedSeq=0；CC-12 字段 0/空串/0", () => {
    const room = new RoomState();
    expect(room.serverTimeMs).toBe(0);
    expect(room.dayIndex).toBe(0);
    expect(room.seasonId).toBe("");
    expect(room.weatherIntensity).toBe(0);
    expect(new PlayerState().lastProcessedSeq).toBe(0);
  });

  it("字段追加在末尾，既有字段索引不变（服务端 schema）", () => {
    expect(Object.getOwnPropertyNames(RoomState.prototype)).toEqual([
      "constructor",
      "tick",
      "hour",
      "phase",
      "players",
      "weatherId",
      "phaseId",
      "phaseProgress",
      "offers",
      "serverTimeMs",
      "dayIndex",
      "seasonId",
      "weatherIntensity",
    ]);
    expect(Object.getOwnPropertyNames(PlayerState.prototype)).toEqual([
      "constructor",
      "sessionId",
      "entityId",
      "mapId",
      "visibleEntities",
      "mapVersion",
      "displayName",
      "characterId",
      "appearance",
      "lastProcessedSeq",
    ]);
  });

  it("生成的客户端副本同样把新字段放在末尾（TS + GDScript）", () => {
    const client = readFileSync("src/network/colyseus/client-schema/schema.ts", "utf8");
    const roomFields = schemaFields(client, "RoomState");
    const playerFields = schemaFields(client, "PlayerState");
    expect(roomFields.at(-3)).toBe('"uint32":dayIndex');
    expect(roomFields.at(-2)).toBe('"string":seasonId');
    expect(roomFields.at(-1)).toBe('"float64":weatherIntensity');
    expect(roomFields.slice(0, 8)).toEqual([
      '"uint32":tick',
      '"float64":hour',
      '"uint8":phase',
      "{ map: PlayerState }:players",
      '"string":weatherId',
      '"string":phaseId',
      '"number":phaseProgress',
      '{ map: "string" }:offers',
    ]);
    expect(playerFields.at(-1)).toBe('"uint32":lastProcessedSeq');

    // GDScript 副本（存在时）：新字段是各自 definition 数组的最后一项。
    const gdPath = new URL("../../../godot-client/generated/schema.gd", import.meta.url);
    if (existsSync(gdPath)) {
      const gd = readFileSync(gdPath, "utf8");
      const playerBlock = gd.slice(
        gd.indexOf("class PlayerState"),
        gd.indexOf("class RoomState"),
      );
      const roomBlock = gd.slice(gd.indexOf("class RoomState"));
      const fieldNames = (block: string): string[] =>
        [...block.matchAll(/Field\.new\("(\w+)"/g)].map((match) => match[1]!);
      expect(fieldNames(playerBlock).at(-1)).toBe("lastProcessedSeq");
      expect(fieldNames(roomBlock).slice(-3)).toEqual([
        "dayIndex",
        "seasonId",
        "weatherIntensity",
      ]);
    }
  });

  it("编码往返保真（float64 逻辑时间 / uint32 输入 ack）", () => {
    const state = new RoomState();
    state.tick = 123;
    state.serverTimeMs = 6150;
    const player = new PlayerState();
    player.sessionId = "s1";
    player.entityId = 1;
    player.lastProcessedSeq = 42;
    state.players.set("s1", player);

    const bytes = new Encoder(state).encodeAll();
    const decoded = new RoomState();
    new Decoder(decoded).decode(bytes);

    expect(decoded.tick).toBe(123);
    expect(decoded.serverTimeMs).toBe(6150);
    expect(decoded.players.get("s1")?.lastProcessedSeq).toBe(42);
  });
});

// ─── serverTimeMs ───────────────────────────────────────────────────────

describe("RoomState.serverTimeMs（逻辑时间）", () => {
  it("等于 tick × fixedDtMs；多步回调只反映最后一步，不随墙钟跳变", async () => {
    const sim = await createGameSimulation(createDefaultGameDefinition());
    const room = makeRoom(sim);
    joinRoom(room, makeClient("s1"));
    const access = reach(room);

    access.onTick(50, 50);
    const tick1 = room.state.tick;
    expect(tick1).toBeGreaterThan(0);
    expect(room.state.serverTimeMs).toBe(tick1 * 50);

    // 120ms：2 步（余 20ms）——serverTimeMs 跟随最后一步 tick
    access.onTick(120, 50);
    expect(room.state.tick).toBe(tick1 + 2);
    expect(room.state.serverTimeMs).toBe((tick1 + 2) * 50);

    // 30ms + 余 20ms = 1 步
    access.onTick(30, 50);
    expect(room.state.tick).toBe(tick1 + 3);
    expect(room.state.serverTimeMs).toBe((tick1 + 3) * 50);
    // 逻辑时间恒为固定步长整数倍（不是 Date.now 量级）
    expect(room.state.serverTimeMs % 50).toBe(0);
  });
});

// ─── 输入 ack ───────────────────────────────────────────────────────────

describe("GameSimulation.getLastProcessedSeq（输入 ack）", () => {
  it("递增输入跟随；超速被拒不推进；乱序/重复不推进；非法 seq 不推进", async () => {
    const sim = await createGameSimulation(defWithMoveLimit(10));
    sim.addPlayer("s1");

    expect(sim.getLastProcessedSeq?.("s1")).toBe(0);
    expect(sim.getLastProcessedSeq?.("unknown")).toBe(0);

    sim.submitInput("s1", { seq: 1, moveX: 0, moveY: 0 });
    expect(sim.getLastProcessedSeq?.("s1")).toBe(1);

    // 超速：被拒且不推进 ack（客户端不能靠重发推进）
    sim.submitInput("s1", { seq: 2, moveX: 100, moveY: 0 });
    expect(sim.getLastProcessedSeq?.("s1")).toBe(1);

    // 同一 seq 以合法速度重发：通过验证后成为新 ack
    sim.submitInput("s1", { seq: 2, moveX: 10, moveY: 0 });
    expect(sim.getLastProcessedSeq?.("s1")).toBe(2);

    // 乱序 / 重复：不推进
    sim.submitInput("s1", { seq: 1, moveX: 0, moveY: 0 });
    sim.submitInput("s1", { seq: 2, moveX: 0, moveY: 0 });
    expect(sim.getLastProcessedSeq?.("s1")).toBe(2);

    // tick 不改变已接受 seq
    sim.tick(50);
    expect(sim.getLastProcessedSeq?.("s1")).toBe(2);

    // 非法 seq（NaN）：入口拒绝，不推进
    sim.submitInput("s1", { seq: Number.NaN, moveX: 0, moveY: 0 });
    expect(sim.getLastProcessedSeq?.("s1")).toBe(2);
  });
});

describe("GameRoom 写入 PlayerState.lastProcessedSeq", () => {
  it("每 tick 写入各自会话的 ack；被拒输入不前进（per-player 隔离）", async () => {
    const sim = await createGameSimulation(defWithMoveLimit(10));
    const room = makeRoom(sim);
    joinRoom(room, makeClient("s1"));
    joinRoom(room, makeClient("s2"));
    const access = reach(room);

    const s1 = room.state.players.get("s1")!;
    const s2 = room.state.players.get("s2")!;
    expect(s1.lastProcessedSeq).toBe(0);
    expect(s2.lastProcessedSeq).toBe(0);

    sim.submitInput("s1", { seq: 4, moveX: 0, moveY: 0 });
    access.onTick(50, 50);
    expect(s1.lastProcessedSeq).toBe(4);
    expect(s2.lastProcessedSeq).toBe(0);

    // 超速被拒：ack 停在 4
    sim.submitInput("s1", { seq: 5, moveX: 100, moveY: 0 });
    access.onTick(50, 50);
    expect(s1.lastProcessedSeq).toBe(4);

    // 多步回调（120ms → 2 步）：ack 仍反映已接受的最后一条
    sim.submitInput("s1", { seq: 5, moveX: 1, moveY: 0 });
    access.onTick(120, 50);
    expect(s1.lastProcessedSeq).toBe(5);
    expect(s2.lastProcessedSeq).toBe(0);

    // 乱序/重复：不前进
    sim.submitInput("s1", { seq: 3, moveX: 0, moveY: 0 });
    access.onTick(50, 50);
    expect(s1.lastProcessedSeq).toBe(5);
  });
});
