/**
 * 分图（per-player maps）GameRoom 测试（per-player-maps 计划 todo 13）。
 *
 * 覆盖：
 * - applySnapshot 由 snapshot.playerMaps 写每玩家 PlayerState.mapId
 * - 两玩家不同图：各自 visibleEntities 只含本图实体（interest 同图过滤 + 单路径 per-client）
 * - 调试推送 per-client：subscribe / 节流推送 / 地图切换后完整快照都按客户端所在图
 *   调 sim.getDebugSnapshot 并单发（fake sim 捕获 mapId 参数）
 * - onLeave 清理 debugMapSentSubscribers 条目
 *
 * GameRoom 直接实例化（Colyseus Room 构造无必需参数）；私有 sim / applySnapshot /
 * pushCollisionDebugSnapshots / sendCollisionDebugSnapshot / onMapChanged 经
 * `as unknown as` 结构访问器注入/调用（镜像 slice5 simWorld 私有访问器模式）。
 * 玩家地图归属镜像 per-player-maps-interest.test.ts：addPlayer + EntityMap 直写
 * （默认定义无地图配置，EntityMap 只记标识不校验图激活，todo 4/11 语义）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { Client } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createGameSimulation,
  createDefaultGameDefinition,
  spawnEntity,
  getRegistries,
} from "framework/index";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { EntityMap } from "framework/components/entityMap";
import type { GameWorld } from "framework/world";
import { GameRoom } from "network/colyseus/rooms/GameRoom";
import { RoomState } from "network/colyseus/state/RoomState";
import { PlayerState } from "network/colyseus/state/PlayerState";
import type {
  TickResult,
  DebugSnapshotOptions,
  SimulationPort,
} from "simulation";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

/** 取仿真内部的 GameWorld（镜像 slice5 simWorld 私有访问器）。 */
function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

/** 清空 EntityMap 模块级单例残留（AoS 数组跨 world 复用 eid，防跨用例串扰）。 */
function clearEntityMap(): void {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
}

/** 造一个指定坐标/地图的 item 实体（与 interest 测试同一 spawn 路径）。 */
function spawnItem(world: GameWorld, x: number, y: number, mapId: string): number {
  return spawnEntity(
    world,
    world.archetypes.get("item"),
    getRegistries().componentRegistry,
    { x, y, mapId },
  );
}

/** 模拟客户端：记录 send 出来的消息（sessionId + 可选 view）。 */
type FakeClient = {
  sessionId: string;
  view?: StateView;
  sent: Array<{ type: string; payload: unknown }>;
  send: (type: string, payload: unknown) => void;
};

function makeClient(sessionId: string): FakeClient {
  const sent: Array<{ type: string; payload: unknown }> = [];
  return {
    sessionId,
    sent,
    send(type: string, payload: unknown) {
      sent.push({ type, payload });
    },
  };
}

/**
 * 搭一个最小 GameRoom 房间：state + 每个玩家一个 mock 客户端（含 onJoin 同款
 * PlayerState + StateView 接线），返回 client/playerState 方便断言。
 */
function makeWiredRoom(
  players: Array<{ sessionId: string; networkId: number }>,
): {
  room: GameRoom;
  clients: FakeClient[];
  playerStates: Map<string, PlayerState>;
} {
  const room = new GameRoom();
  room.state = new RoomState();

  const clients = players.map((p) => makeClient(p.sessionId));
  const playerStates = new Map<string, PlayerState>();
  players.forEach((p, i) => {
    const ps = new PlayerState();
    ps.sessionId = p.sessionId;
    ps.entityId = p.networkId;
    ps.visibleEntities.ownerSessionId = p.sessionId;
    room.state.players.set(p.sessionId, ps);
    // 先挂 state 再 add 进 view（未挂 state 的实例会被 StateView 判为 detached）
    const view = new StateView();
    view.add(ps);
    clients[i]!.view = view;
    playerStates.set(p.sessionId, ps);
  });
  room.clients.push(...(clients as unknown as Client[]));

  return { room, clients, playerStates };
}

/** 私有成员/方法访问器（镜像 slice5 的私有 `world` 访问器模式）。 */
type GameRoomTestAccess = {
  sim: SimulationPort;
  debugSubscribers: Set<string>;
  debugMapSentSubscribers: Map<string, string>;
  applySnapshot: (result: TickResult) => void;
  pushCollisionDebugSnapshots: (deltaTimeMs: number) => void;
  sendCollisionDebugSnapshot: (client: Client, forceIncludeMapBodies?: boolean) => void;
  onMapChanged: () => void;
};

function reach(room: GameRoom): GameRoomTestAccess {
  return room as unknown as GameRoomTestAccess;
}

/** 造两玩家两图的真实仿真（两玩家 EntityMap 分属 map-a / map-b，各自图上放一个 item）。 */
async function twoMapSim() {
  const sim = await createGameSimulation(createDefaultGameDefinition());
  const world = simWorld(sim);
  const join1 = sim.addPlayer("s1");
  const join2 = sim.addPlayer("s2");
  const [p1, p2] = query(world, [Player]);
  EntityMap[p1] = "map-a";
  EntityMap[p2] = "map-b";
  const aItem = spawnItem(world, 3, 3, "map-a");
  const bItem = spawnItem(world, 6, 6, "map-b");
  const networkIds = {
    join1: join1.networkId,
    join2: join2.networkId,
    aItem: NetworkId.value[aItem],
    bItem: NetworkId.value[bItem],
  };
  return { sim, world, networkIds };
}

describe("gameroom", () => {
  it("a) applySnapshot 写每玩家 PlayerState.mapId（playerMaps）；可见表只含本图实体", async () => {
    clearEntityMap();
    const { sim, networkIds } = await twoMapSim();
    const { room, playerStates } = makeWiredRoom([
      { sessionId: "s1", networkId: networkIds.join1 },
      { sessionId: "s2", networkId: networkIds.join2 },
    ]);
    const access = reach(room);
    access.sim = sim;

    access.applySnapshot(sim.tick(50));

    const s1 = playerStates.get("s1")!;
    const s2 = playerStates.get("s2")!;
    // 每玩家 PlayerState.mapId 写自 snapshot.playerMaps
    expect(s1.mapId).toBe("map-a");
    expect(s2.mapId).toBe("map-b");
    // 各自可见表只含本图实体（跨图 item / 跨图玩家不可见；own 恒可见）
    expect(s1.visibleEntities.has(String(networkIds.aItem))).toBe(true);
    expect(s1.visibleEntities.has(String(networkIds.bItem))).toBe(false);
    expect(s1.visibleEntities.has(String(networkIds.join2))).toBe(false);
    expect(s1.visibleEntities.has(String(networkIds.join1))).toBe(true);
    expect(s2.visibleEntities.has(String(networkIds.bItem))).toBe(true);
    expect(s2.visibleEntities.has(String(networkIds.aItem))).toBe(false);
    expect(s2.visibleEntities.has(String(networkIds.join2))).toBe(true);
  });

  it("b) 两玩家不同图：visibleEntities 无交集（无跨图泄漏）", async () => {
    clearEntityMap();
    const { sim, world, networkIds } = await twoMapSim();
    const { room, playerStates } = makeWiredRoom([
      { sessionId: "s1", networkId: networkIds.join1 },
      { sessionId: "s2", networkId: networkIds.join2 },
    ]);
    const access = reach(room);
    access.sim = sim;

    access.applySnapshot(sim.tick(50));

    const s1Keys = new Set([...playerStates.get("s1")!.visibleEntities.keys()]);
    for (const key of playerStates.get("s2")!.visibleEntities.keys()) {
      expect(s1Keys.has(key)).toBe(false);
    }
    // networkId → eid 回查：s1 可见实体全在 map-a，s2 可见实体全在 map-b
    const eidByNetwork = new Map<number, number>();
    for (const eid of query(world, [NetworkId])) {
      eidByNetwork.set(NetworkId.value[eid], eid);
    }
    for (const key of s1Keys) {
      expect(EntityMap[eidByNetwork.get(Number(key))!]).toBe("map-a");
    }
    for (const key of playerStates.get("s2")!.visibleEntities.keys()) {
      expect(EntityMap[eidByNetwork.get(Number(key))!]).toBe("map-b");
    }
    // 双图各自至少 own + item 两个（防空集通过）
    expect(s1Keys.size).toBeGreaterThanOrEqual(2);
    expect(playerStates.get("s2")!.visibleEntities.size).toBeGreaterThanOrEqual(2);
  });

  it("c) 调试推送 per-client：mapId 贯穿 getDebugSnapshot 并单发给各自客户端", () => {
    const { room, clients, playerStates } = makeWiredRoom([
      { sessionId: "s1", networkId: 1 },
      { sessionId: "s2", networkId: 2 },
    ]);
    const access = reach(room);
    const debugCalls: DebugSnapshotOptions[] = [];
    access.sim = {
      getDebugSnapshot(options?: DebugSnapshotOptions) {
        debugCalls.push(options ?? {});
        return { tick: 1, mapId: options?.mapId ?? null };
      },
    } as unknown as SimulationPort;

    playerStates.get("s1")!.mapId = "map-a";
    playerStates.get("s2")!.mapId = "map-b";
    access.debugSubscribers.add("s1");
    access.debugSubscribers.add("s2");

    // 订阅走 sendCollisionDebugSnapshot(client, true)：按该客户端所在图取快照
    access.sendCollisionDebugSnapshot(clients[0] as unknown as Client, true);
    expect(debugCalls[0]).toEqual({ includeMapBodies: true, mapId: "map-a" });
    expect(clients[0]!.sent.at(-1)?.payload).toEqual({ tick: 1, mapId: "map-a" });

    // 节流推送：逐客户端按各自当前图取快照并各发一份
    access.pushCollisionDebugSnapshots(500);
    expect(debugCalls[1]).toEqual({ includeMapBodies: false, mapId: "map-a" });
    expect(debugCalls[2]).toEqual({ includeMapBodies: false, mapId: "map-b" });
    expect(clients[0]!.sent.at(-1)?.payload).toEqual({ tick: 1, mapId: "map-a" });
    expect(clients[1]!.sent.at(-1)?.payload).toEqual({ tick: 1, mapId: "map-b" });
    expect(clients[0]!.sent.at(-1)?.payload).not.toEqual(clients[1]!.sent.at(-1)?.payload);

    // 地图切换（s1 → map-b）：标记重置并立即推其新图完整快照；s2 不被无谓重推
    playerStates.get("s1")!.mapId = "map-b";
    access.onMapChanged();
    expect(access.debugMapSentSubscribers.get("s1")).toBe("map-b");
    expect(debugCalls.at(-1)).toEqual({ includeMapBodies: true, mapId: "map-b" });
    expect(clients[0]!.sent.at(-1)?.payload).toEqual({ tick: 1, mapId: "map-b" });
    expect(clients[1]!.sent.length).toBe(2);
  });

  it("d) onLeave 清理 debugMapSentSubscribers 条目", () => {
    const { room, clients } = makeWiredRoom([{ sessionId: "s1", networkId: 1 }]);
    const access = reach(room);
    access.sim = { removePlayer() {} } as unknown as SimulationPort;
    access.debugSubscribers.add("s1");
    access.debugMapSentSubscribers.set("s1", "map-a");

    room.onLeave(clients[0] as unknown as Client);

    expect(access.debugSubscribers.has("s1")).toBe(false);
    expect(access.debugMapSentSubscribers.has("s1")).toBe(false);
    expect(room.state.players.has("s1")).toBe(false);
  });
});
