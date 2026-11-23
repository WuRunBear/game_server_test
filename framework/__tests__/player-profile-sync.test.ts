/**
 * CC-10 Player Profile：GameRoom PlayerState 写入 + 他人装备 kind 派生 + 隐私边界。
 *
 * 覆盖：
 * - onJoin 读取 join options 写入 PlayerState.displayName/characterId/appearance；
 *   applySnapshot 每 tick 从仿真层只读访问器刷新；无 options → 空串；
 * - 断线保留玩家不在 clients 中 → 其（已删除的）PlayerState 不会被补写；
 * - 他人装备：Equipment 槽位索引 + Inventory.slots[slot].kind 派生
 *   `Equipment.weaponKind/toolKind/armorKind`，空槽不写键；
 * - 隐私：其他玩家的 `Inventory.*` 一律不下发，只给三个装备槽的 kind；
 * - game.json 的 netSync 末尾追加 equipment 派生条目（旧条目不动）。
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent } from "bitecs";
import type { Client } from "@colyseus/core";
import { StateView } from "@colyseus/schema";

import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameSimulation,
} from "framework/index";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { GameWorld } from "framework/world";
import type { SimulationPort, TickResult } from "simulation";
import { Equipment } from "framework/components/equipment";
import { Inventory } from "framework/components/inventory";
import { setPlayerProfile } from "framework/components/playerProfile";
import { GameRoom } from "network/colyseus/rooms/GameRoom";
import { RoomState } from "network/colyseus/state/RoomState";
import { PlayerState } from "network/colyseus/state/PlayerState";
import { PROTOCOL_VERSION } from "network/protocol";

beforeAll(() => {
  bootstrapFramework();
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

type FakeClient = {
  sessionId: string;
  view?: StateView;
  send: (type: string, payload: unknown) => void;
};

type GameRoomAccess = {
  sim: SimulationPort;
  applySnapshot: (result: TickResult) => void;
};

function reach(room: GameRoom): GameRoomAccess {
  return room as unknown as GameRoomAccess;
}

function makeRoom(sim: SimulationPort): GameRoom {
  const room = new GameRoom();
  room.state = new RoomState();
  reach(room).sim = sim;
  return room;
}

function addClient(room: GameRoom, sessionId: string): FakeClient {
  const client: FakeClient = { sessionId, send: () => {} };
  (room.clients as unknown as FakeClient[]).push(client);
  return client;
}

/** 带装备派生所需 netSync 条目的测试定义（玩家背包/装备/装备 kind）。 */
function equipmentDef(): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.netSync = {
    fields: [
      { component: "Transform", fields: ["x", "y"] },
      { component: "Kind", fields: ["value"] },
      { component: "Inventory", tags: ["Player"], fields: ["slots"] },
      { component: "Kind", tags: ["Player"], fields: ["equipment"] },
    ],
  };
  return def;
}

// ─── PlayerState 展示资料 ────────────────────────────────────────────────

describe("GameRoom PlayerState 展示资料", () => {
  it("onJoin 读 options + applySnapshot 刷新；无 options 回退空串", async () => {
    const sim = await createGameSimulation(createDefaultGameDefinition());
    const room = makeRoom(sim);
    const c1 = addClient(room, "s1");
    const c2 = addClient(room, "s2");

    room.onJoin(c1 as unknown as Client, {
      protocolVersion: PROTOCOL_VERSION,
      displayName: "  Alice  ",
      characterId: " hero_1 ",
      appearance: '{"skin":"red"}',
    });
    room.onJoin(c2 as unknown as Client, { protocolVersion: PROTOCOL_VERSION });

    const s1 = room.state.players.get("s1")!;
    const s2 = room.state.players.get("s2")!;
    expect(s1.displayName).toBe("Alice");
    expect(s1.characterId).toBe("hero_1");
    expect(s1.appearance).toBe('{"skin":"red"}');
    // 无 options：空串（客户端自行回退「玩家」/networkId/默认外观）
    expect([s2.displayName, s2.characterId, s2.appearance]).toEqual(["", "", ""]);

    // applySnapshot：三字段仍来自仿真层访问器（不因逐帧同步丢失）
    reach(room).applySnapshot(sim.tick(50));
    expect([s1.displayName, s1.characterId, s1.appearance]).toEqual([
      "Alice",
      "hero_1",
      '{"skin":"red"}',
    ]);

    // 仿真层资料变化 → 下一帧 applySnapshot 反映
    setPlayerProfile(playerEidOf(sim, "s1"), {
      displayName: "Alice2",
      characterId: "hero_2",
      appearance: '{"skin":"blue"}',
    });
    reach(room).applySnapshot(sim.tick(50));
    expect([s1.displayName, s1.characterId, s1.appearance]).toEqual([
      "Alice2",
      "hero_2",
      '{"skin":"blue"}',
    ]);
  });

  it("断线保留玩家不在 clients：applySnapshot 不写其 PlayerState", async () => {
    const sim = await createGameSimulation(createDefaultGameDefinition());
    const room = makeRoom(sim);
    const c1 = addClient(room, "s1");
    room.onJoin(c1 as unknown as Client, {
      protocolVersion: PROTOCOL_VERSION,
      displayName: "Alice",
    });

    // 模拟一条已无连接、但仍留在 players 表中的状态（真实 onLeave 会删除；
    // 这里用于证明 applySnapshot 只遍历在线 clients，不做全表回填）。
    const orphan = new PlayerState();
    orphan.sessionId = "offline";
    orphan.entityId = sim.addPlayer("offline", { displayName: "Ghost" }).networkId;
    room.state.players.set("offline", orphan);

    reach(room).applySnapshot(sim.tick(50));
    expect(orphan.displayName).toBe("");
    expect(orphan.characterId).toBe("");
    expect(orphan.appearance).toBe("");
  });
});

// ─── 他人装备 kind ───────────────────────────────────────────────────────

describe("他人装备 kind 派生", () => {
  it("只发 weapon/tool/armor 三个 kind；空槽无键；不泄漏他人背包", async () => {
    const sim = await createGameSimulation(equipmentDef());
    const room = makeRoom(sim);
    const c1 = addClient(room, "s1");
    const c2 = addClient(room, "s2");
    room.onJoin(c1 as unknown as Client, { protocolVersion: PROTOCOL_VERSION });
    room.onJoin(c2 as unknown as Client, { protocolVersion: PROTOCOL_VERSION });

    const world = simWorld(sim);
    const p2 = playerEidOf(sim, "s2");
    Inventory[p2] = {
      capacity: 5,
      slots: [
        { kind: "axe", count: 1, durability: 7 },
        { kind: "spear", count: 1 },
        { kind: "leather_armor", count: 1 },
        // 非装备槽内容：绝不应出现在他人快照里
        { kind: "bread", count: 5 },
        null,
      ],
    };
    addComponent(world, p2, Equipment);
    Equipment.weaponSlot[p2] = 0;
    Equipment.toolSlot[p2] = 1;
    Equipment.armorSlot[p2] = 2;

    const result = sim.tick(50);
    // 原始快照已带派生 kind（适配器路径）
    const s1 = room.state.players.get("s1")!;
    const s2NetworkId = room.state.players.get("s2")!.entityId;
    const rawByNetworkId = result.snapshot.entities.get(s2NetworkId)!;
    expect(rawByNetworkId.strings["Equipment.weaponKind"]).toBe("axe");
    expect(rawByNetworkId.strings["Equipment.toolKind"]).toBe("spear");
    expect(rawByNetworkId.strings["Equipment.armorKind"]).toBe("leather_armor");
    // 只派生三个 kind 键，不带槽位索引/数量/耐久等其他内容
    expect(
      Object.keys(rawByNetworkId.strings).filter((key) => key.startsWith("Equipment.")),
    ).toEqual(["Equipment.weaponKind", "Equipment.toolKind", "Equipment.armorKind"]);

    reach(room).applySnapshot(result);
    const other = s1.visibleEntities.get(String(s2NetworkId))!;
    expect(other).toBeDefined();
    expect(other.stringValues.get("Equipment.weaponKind")).toBe("axe");
    expect(other.stringValues.get("Equipment.toolKind")).toBe("spear");
    expect(other.stringValues.get("Equipment.armorKind")).toBe("leather_armor");

    // 隐私：他人 Inventory.* 一律被裁掉（含非装备槽 bread / 耐久等）
    const leaked = [...other.stringValues.keys()].filter((key) =>
      key.startsWith("Inventory."),
    );
    expect(leaked).toEqual([]);
    expect([...other.values.keys()].filter((key) => key.startsWith("Inventory."))).toEqual([]);

    // 空槽（引用 null 槽）不写键 → 下一帧 key diff 清掉旧值
    Equipment.armorSlot[p2] = 4;
    const next = sim.tick(50);
    expect(next.snapshot.entities.get(s2NetworkId)!.strings["Equipment.armorKind"]).toBeUndefined();
    reach(room).applySnapshot(next);
    expect(other.stringValues.has("Equipment.armorKind")).toBe(false);
    expect(other.stringValues.get("Equipment.weaponKind")).toBe("axe");
    expect(other.stringValues.get("Equipment.toolKind")).toBe("spear");
  });

  it("game.json netSync 末尾追加 equipment 派生条目，旧条目顺序不变", () => {
    const raw = JSON.parse(readFileSync("game/game.json", "utf8")) as {
      netSync: { fields: Array<{ component: string; tags?: string[]; fields: string[] }> };
    };
    const fields = raw.netSync.fields;
    expect(fields.at(-1)).toEqual({
      component: "Kind",
      tags: ["Player"],
      fields: ["equipment"],
    });
    expect(fields.at(-2)).toEqual({
      component: "Kind",
      tags: ["Player"],
      fields: ["exposure"],
    });
  });
});
