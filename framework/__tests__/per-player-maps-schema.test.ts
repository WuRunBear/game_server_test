/**
 * Per-player maps — schema 协议测试（todo 12）。
 *
 * 协议破坏性变更：RoomState 的房间级 mapId/entities 字段移除（房间级语义死亡），
 * mapId 下沉到 PlayerState（每个玩家各自所属地图）；实体同步恒走 per-client
 * 可见表（todo 13 细化）。客户端 schema（src/network/colyseus/client-schema/schema.ts）
 * 为手工同步副本（仓库无 codegen），本文件含文本级校验。
 *
 * 覆盖：
 * a) PlayerState.mapId 存在、默认 ""、可设置、编码往返
 * b) RoomState 不含 mapId / entities（实例与编码往返均不携带）
 * c) 房间级 tick/hour/phase 与 per-client 视图路径的编码往返不崩（冒烟）
 * d) client-schema 手工副本：PlayerState 含 mapId，RoomState 已移除 mapId/entities
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Encoder, Decoder, StateView } from "@colyseus/schema";

import { PlayerState } from "framework/net/colyseus/state/PlayerState";
import { RoomState } from "framework/net/colyseus/state/RoomState";

/** 编码整棵 RoomState 并解码到新实例（共享通路，无 per-client 视图）。 */
function roundtrip(state: RoomState): RoomState {
  const bytes = new Encoder(state).encodeAll();
  const decoded = new RoomState();
  new Decoder(decoded).decode(bytes);
  return decoded;
}

describe("schema", () => {
  it("a) PlayerState.mapId：字段存在、默认空串、可设置", () => {
    const ps = new PlayerState();
    expect(ps.mapId).toBe("");
    ps.mapId = "cave";
    expect(ps.mapId).toBe("cave");
  });

  it("a) PlayerState.mapId：编码往返（默认值与设置值均保真）", () => {
    const state = new RoomState();
    const p1 = new PlayerState();
    p1.sessionId = "s1";
    p1.entityId = 1;
    state.players.set("s1", p1);
    const p2 = new PlayerState();
    p2.sessionId = "s2";
    p2.entityId = 2;
    p2.mapId = "cave";
    state.players.set("s2", p2);

    const decoded = roundtrip(state);
    expect(decoded.players.get("s1")?.mapId).toBe("");
    expect(decoded.players.get("s2")?.mapId).toBe("cave");
  });

  it("b) RoomState 实例不含房间级 mapId / entities 字段（其余字段保留）", () => {
    const state = new RoomState();
    expect("mapId" in state).toBe(false);
    expect(Object.hasOwn(state, "mapId")).toBe(false);
    expect("entities" in state).toBe(false);
    expect(Object.hasOwn(state, "entities")).toBe(false);
    // 其余字段仍在：tick/hour/phase/players
    expect(state.tick).toBe(0);
    expect(state.hour).toBe(8);
    expect(state.phase).toBe(0);
    expect(state.players.size).toBe(0);
  });

  it("b) RoomState 编码往返同样不携带 mapId / entities", () => {
    const state = new RoomState();
    state.tick = 7;
    state.hour = 10.25;
    state.phase = 1;

    const decoded = roundtrip(state);
    expect("mapId" in decoded).toBe(false);
    expect(Object.hasOwn(decoded, "mapId")).toBe(false);
    expect("entities" in decoded).toBe(false);
    expect(Object.hasOwn(decoded, "entities")).toBe(false);
    expect(decoded.tick).toBe(7);
    expect(decoded.hour).toBe(10.25);
    expect(decoded.phase).toBe(1);
  });

  it("c) 冒烟：房间级 tick/hour/phase 经共享全量编码同步", () => {
    const state = new RoomState();
    state.tick = 42;
    state.hour = 13.5;
    state.phase = 1;

    const decoded = roundtrip(state);
    expect(decoded.tick).toBe(42);
    expect(decoded.hour).toBe(13.5);
    expect(decoded.phase).toBe(1);
  });

  it("c) 冒烟：per-client 视图路径（GameRoom.onJoin 同款接线）不崩", () => {
    const state = new RoomState();
    state.tick = 42;

    const playerA = new PlayerState();
    playerA.sessionId = "sA";
    playerA.entityId = 1;
    playerA.mapId = "generated-map";
    playerA.visibleEntities.ownerSessionId = "sA";
    state.players.set("sA", playerA);

    const encoder = new Encoder(state);
    const buffer = new Uint8Array(Encoder.BUFFER_SIZE);
    const sharedIt = { offset: 1 };
    encoder.encodeAll(sharedIt, buffer);

    const viewA = new StateView();
    viewA.add(playerA);
    const itA = { offset: sharedIt.offset };
    const bytesA = encoder.encodeAllView(viewA, sharedIt.offset, itA, buffer);

    const decoded = new RoomState();
    new Decoder(decoded).decode(bytesA);
    expect(decoded.players.get("sA")?.sessionId).toBe("sA");
    expect(decoded.players.get("sA")?.mapId).toBe("generated-map");
  });

  it("d) client-schema 手工副本与服务端 schema 同步（文本级校验）", () => {
    const source = readFileSync(
      new URL("../../src/network/colyseus/client-schema/schema.ts", import.meta.url),
      "utf8",
    );

    const playerBlock = source.slice(
      source.indexOf("export class PlayerState"),
      source.indexOf("export class RoomState"),
    );
    // PlayerState 必须新增 mapId（string 类型）
    expect(playerBlock).toContain('@type("string") public mapId!: string;');

    const roomBlock = source.slice(source.indexOf("export class RoomState"));
    // RoomState 不得再含地图/实体房间级字段
    expect(roomBlock).not.toContain("mapId");
    expect(roomBlock).not.toContain("entities");
  });
});
