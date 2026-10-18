/**
 * 批次 C（F-06）协议补全测试：层号 / 建造角色 / 耐久 / 制作进度 / 离线门控。
 *
 * 覆盖验证清单：
 * ① EntityState.level 由 per-client 快照写入（多层实体：玩家/建造物）
 * ② Structure 字段经 netSync 同步（role/connectLow/connectHigh/connectDir）
 * ③ Inventory 槽位 durability 随物品变化（无耐久不写键）；ItemMeta 掉落物耐久
 * ④ 制作进度（recipeId/remainingTicks/progress/suspended）随 tick 推进，
 *    完成后从 EntityState 消失；到点挂起时可感知
 * ⑤ 离线保留实体不出现在他人快照（回归）
 * ⑥ 真实 game.json 的 netSync 接线包含本批新增条目
 *
 * 说明：测试用 default 定义 + 与 game.json 同形的 netSync 条目（不启动地图
 * 生成）；真实配置接线由 ⑥ 的 loadGameDefinition 断言覆盖。GameRoom 直接
 * 实例化并经结构访问器调用私有 applySnapshot（沿用 per-player-maps 测试模式）。
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Client } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import { addComponent, addEntity, query } from "bitecs";

import {
  bootstrapFramework,
  createGameSimulation,
  createDefaultGameDefinition,
  loadGameDefinition,
  spawnEntity,
  getRegistries,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { EntityMap } from "framework/components/entityMap";
import { EntityLevel } from "framework/components/entityLevel";
import { Inventory } from "framework/components/inventory";
import { ItemMeta } from "framework/components/itemMeta";
import {
  Structure,
  STRUCTURE_ROLE_CONNECTOR,
  STRUCTURE_ROLE_FLOOR,
  CONNECTOR_DIR_UP,
} from "framework/components/structure";
import { craftRecipe } from "framework/systems/gameplay/craftingSystem";
import type { GameWorld } from "framework/world";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import { GameRoom } from "network/colyseus/rooms/GameRoom";
import { RoomState } from "network/colyseus/state/RoomState";
import { PlayerState } from "network/colyseus/state/PlayerState";
import type { EntityState } from "network/colyseus/state/EntityState";
import type { SimulationPort, TickResult } from "simulation";

beforeAll(() => {
  bootstrapFramework();
});

beforeEach(() => {
  // legacy AoS 数组跨 world 共享 eid：逐用例清空，防串扰
  for (let i = 0; i < Inventory.length; i++) Inventory[i] = undefined;
  for (let i = 0; i < ItemMeta.length; i++) ItemMeta[i] = undefined;
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
  for (let i = 0; i < EntityLevel.length; i++) EntityLevel[i] = undefined;
});

/** 协议测试配置：与 game.json 同形的 netSync 条目，去掉地形层号系统以便直写层级。 */
function protocolDef(): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.systems = (def.systems ?? []).filter((s) => s.id !== "entity-level");
  def.netSync = {
    fields: [
      { component: "Transform", fields: ["x", "y"] },
      { component: "Structure", fields: ["role", "connectLow", "connectHigh", "connectDir"] },
      { component: "Inventory", tags: ["Player"], fields: ["slots", "durability"] },
      { component: "ItemMeta", tags: ["Item"], fields: ["kind", "count", "durability"] },
      { component: "Crafting", tags: ["Player"], fields: ["jobs"] },
    ],
  };
  return def;
}

/** 取仿真内部 GameWorld（镜像既有测试的私有访问器）。 */
function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

/** 造一个建造结构实体（楼层/连接器）。 */
function spawnStructure(
  world: GameWorld,
  opts: {
    level: number;
    x: number;
    y: number;
    role?: number;
    connectLow?: number;
    connectHigh?: number;
    connectDir?: number;
  },
): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Structure);
  Transform.x[eid] = opts.x;
  Transform.y[eid] = opts.y;
  Structure.role[eid] = opts.role ?? STRUCTURE_ROLE_FLOOR;
  Structure.connectLow[eid] = opts.connectLow ?? 0;
  Structure.connectHigh[eid] = opts.connectHigh ?? 0;
  Structure.connectDir[eid] = opts.connectDir ?? 0;
  NetworkId.value[eid] = world.nextNetworkId++;
  EntityMap[eid] = world.defaultMapId;
  EntityLevel[eid] = opts.level;
  return eid;
}

/** 造一个带 Item 标签的地面掉落物（沿用内建 item 原型 + 手写 ItemMeta）。 */
function spawnItemEntity(world: GameWorld, x: number, y: number): number {
  return spawnEntity(world, world.archetypes.get("item"), getRegistries().componentRegistry, {
    x,
    y,
    mapId: world.defaultMapId,
  });
}

/* ---------------------------- GameRoom 接线 ---------------------------- */

type FakeClient = {
  sessionId: string;
  view?: StateView;
  send: (type: string, payload: unknown) => void;
};

function makeWiredRoom(
  players: Array<{ sessionId: string; networkId: number }>,
): {
  room: GameRoom;
  playerStates: Map<string, PlayerState>;
} {
  const room = new GameRoom();
  room.state = new RoomState();
  const playerStates = new Map<string, PlayerState>();
  const clients: FakeClient[] = [];
  for (const p of players) {
    const ps = new PlayerState();
    ps.sessionId = p.sessionId;
    ps.entityId = p.networkId;
    ps.visibleEntities.ownerSessionId = p.sessionId;
    room.state.players.set(p.sessionId, ps);
    const view = new StateView();
    view.add(ps);
    clients.push({ sessionId: p.sessionId, view, send: () => {} });
    playerStates.set(p.sessionId, ps);
  }
  room.clients.push(...(clients as unknown as Client[]));
  return { room, playerStates };
}

type GameRoomTestAccess = {
  sim: SimulationPort;
  applySnapshot: (result: TickResult) => void;
};

function reach(room: GameRoom): GameRoomTestAccess {
  return room as unknown as GameRoomTestAccess;
}

/** 取玩家实体的 networkId（按 query 顺序对应 addPlayer 顺序）。 */
function playerEids(world: GameWorld): number[] {
  return [...query(world, [Player])];
}

/* ------------------------------------------------------------------ */

describe("批次 C：EntityState.level（①）", () => {
  it("per-client 快照按玩家各自层级写入 level（玩家 + 建造物）", async () => {
    const sim = await createGameSimulation(protocolDef());
    const world = simWorld(sim);
    const join1 = sim.addPlayer("s1");
    const join2 = sim.addPlayer("s2");
    const [p1, p2] = playerEids(world);
    // 去掉 entity-level 系统后直写层级：p1 在 2 层、p2 在 1 层
    EntityLevel[p1!] = 2;
    EntityLevel[p2!] = 1;
    Transform.x[p1!] = 100;
    Transform.y[p1!] = 100;
    Transform.x[p2!] = 300;
    Transform.y[p2!] = 300;

    const floorL2 = spawnStructure(world, { level: 2, x: 104, y: 100, role: STRUCTURE_ROLE_FLOOR });
    const stairsL1 = spawnStructure(world, {
      level: 1,
      x: 304,
      y: 300,
      role: STRUCTURE_ROLE_CONNECTOR,
      connectLow: 0,
      connectHigh: 1,
      connectDir: CONNECTOR_DIR_UP,
    });

    const { room, playerStates } = makeWiredRoom([
      { sessionId: "s1", networkId: join1.networkId },
      { sessionId: "s2", networkId: join2.networkId },
    ]);
    reach(room).sim = sim;
    reach(room).applySnapshot(sim.tick(50));

    const s1 = playerStates.get("s1")!;
    const s2 = playerStates.get("s2")!;
    // 自身实体恒可见 → 各自层号写入
    expect(s1.visibleEntities.get(String(join1.networkId))!.level).toBe(2);
    expect(s2.visibleEntities.get(String(join2.networkId))!.level).toBe(1);
    // 同层建造物可见且带层号；异层不可见
    expect(s1.visibleEntities.get(String(NetworkId.value[floorL2]))!.level).toBe(2);
    expect(s1.visibleEntities.has(String(NetworkId.value[stairsL1]))).toBe(false);
    expect(s2.visibleEntities.get(String(NetworkId.value[stairsL1]))!.level).toBe(1);
    expect(s2.visibleEntities.has(String(NetworkId.value[floorL2]))).toBe(false);
  });

  it("缺省层号写 0（无 EntityLevel 条目的普通实体）", async () => {
    const sim = await createGameSimulation(protocolDef());
    const world = simWorld(sim);
    const join = sim.addPlayer("s1");
    const { room, playerStates } = makeWiredRoom([{ sessionId: "s1", networkId: join.networkId }]);
    reach(room).sim = sim;
    reach(room).applySnapshot(sim.tick(50));
    expect(playerStates.get("s1")!.visibleEntities.get(String(join.networkId))!.level).toBe(0);
  });
});

describe("批次 C：Structure 同步（②）", () => {
  it("role/connectLow/connectHigh/connectDir 进入 EntityState.values", async () => {
    const sim = await createGameSimulation(protocolDef());
    const world = simWorld(sim);
    sim.addPlayer("s1");
    const stairs = spawnStructure(world, {
      level: 1,
      x: 10,
      y: 10,
      role: STRUCTURE_ROLE_CONNECTOR,
      connectLow: 0,
      connectHigh: 2,
      connectDir: CONNECTOR_DIR_UP,
    });
    const { snapshot } = sim.tick(50);
    const snap = snapshot.entities.get(NetworkId.value[stairs])!;
    expect(snap.level).toBe(1);
    expect(snap.values["Structure.role"]).toBe(STRUCTURE_ROLE_CONNECTOR);
    expect(snap.values["Structure.connectLow"]).toBe(0);
    expect(snap.values["Structure.connectHigh"]).toBe(2);
    expect(snap.values["Structure.connectDir"]).toBe(CONNECTOR_DIR_UP);

    // GameRoom 写入路径：同层玩家可见（s1 默认 0 层 → 需 own 恒可见；此处直接
    // 用快照断言已覆盖字段，GameRoom 的 EntityState 写入由 ① 验证）
    const { room, playerStates } = makeWiredRoom([{ sessionId: "s1", networkId: NetworkId.value[playerEids(world)[0]!] }]);
    reach(room).sim = sim;
    reach(room).applySnapshot(sim.tick(50));
    const serverEntity = playerStates.get("s1")!.visibleEntities;
    // s1 在 0 层，stairs 在 1 层 → 不可见（同层门控回归）
    expect(serverEntity.has(String(NetworkId.value[stairs]))).toBe(false);
  });
});

describe("批次 C：耐久同步（③）", () => {
  it("Inventory 槽位 durability 随物品变化；无耐久不写键", async () => {
    const sim = await createGameSimulation(protocolDef());
    const world = simWorld(sim);
    const join = sim.addPlayer("s1");
    const player = playerEids(world)[0]!;
    Inventory[player] = {
      capacity: 2,
      slots: [
        { kind: "sword", count: 1, durability: 5 },
        { kind: "wood", count: 3 },
      ],
    };

    const { room, playerStates } = makeWiredRoom([{ sessionId: "s1", networkId: join.networkId }]);
    reach(room).sim = sim;
    reach(room).applySnapshot(sim.tick(50));

    let state = playerStates.get("s1")!.visibleEntities.get(String(join.networkId))!;
    expect(state.values.get("Inventory.0.durability")).toBe(5);
    // 无耐久槽位不出现该键（载荷最小）
    expect(state.values.has("Inventory.1.durability")).toBe(false);

    // 物品变化：slot0 变成无耐久、slot1 获得耐久 → 键随之迁移（key diff 清残留）
    Inventory[player]!.slots[0] = { kind: "sword", count: 1 };
    Inventory[player]!.slots[1] = { kind: "axe", count: 1, durability: 2 };
    reach(room).applySnapshot(sim.tick(50));

    state = playerStates.get("s1")!.visibleEntities.get(String(join.networkId))!;
    expect(state.values.has("Inventory.0.durability")).toBe(false);
    expect(state.values.get("Inventory.1.durability")).toBe(2);
  });

  it("ItemMeta 掉落物耐久同步；无耐久不写键", async () => {
    const sim = await createGameSimulation(protocolDef());
    const world = simWorld(sim);
    const join = sim.addPlayer("s1");
    const item = spawnItemEntity(world, 500, 500);
    ItemMeta[item] = { kind: "sword", count: 1, pickupAfterMs: 0, durability: 7 };

    const { room, playerStates } = makeWiredRoom([{ sessionId: "s1", networkId: join.networkId }]);
    reach(room).sim = sim;
    reach(room).applySnapshot(sim.tick(50));

    let state: EntityState = playerStates.get("s1")!.visibleEntities.get(String(NetworkId.value[item]))!;
    expect(state.values.get("ItemMeta.durability")).toBe(7);

    // 丢失耐久（被修复/新掉落）→ 键消失
    ItemMeta[item] = { kind: "sword", count: 1, pickupAfterMs: 0 };
    reach(room).applySnapshot(sim.tick(50));
    state = playerStates.get("s1")!.visibleEntities.get(String(NetworkId.value[item]))!;
    expect(state.values.has("ItemMeta.durability")).toBe(false);
  });
});

describe("批次 C：制作进度同步（④）", () => {
  const SLOW_RULES = {
    recipes: [
      {
        id: "slow",
        durationTicks: 3,
        inputs: [{ kind: "m", count: 3 }],
        outputs: [{ kind: "out", count: 1 }],
      },
    ],
  };

  it("进度随 tick 推进 → 到点挂起可感知 → 完成后键消失", async () => {
    const sim = await createGameSimulation(protocolDef());
    const world = simWorld(sim);
    const join = sim.addPlayer("s1");
    const player = playerEids(world)[0]!;
    world.gameDef.resolvedRules["crafting"] = SLOW_RULES;
    world.gameDef.itemsByKind = new Map([
      ["m", { kind: "m", maxStack: 50 }],
      ["out", { kind: "out", maxStack: 5 }],
      ["filler", { kind: "filler", maxStack: 5 }],
    ]);
    Inventory[player] = { capacity: 2, slots: [{ kind: "m", count: 3 }, null] };

    expect(craftRecipe(world, player, "slow")).toBe(true);

    const { room, playerStates } = makeWiredRoom([{ sessionId: "s1", networkId: join.networkId }]);
    reach(room).sim = sim;
    const self = (): EntityState =>
      playerStates.get("s1")!.visibleEntities.get(String(join.networkId))!;

    // 第 1 tick：任务在途，进度可感知
    reach(room).applySnapshot(sim.tick(50));
    expect(self().stringValues.get("Crafting.0.recipeId")).toBe("slow");
    expect(self().values.get("Crafting.0.remainingTicks")).toBe(2);
    expect(self().values.get("Crafting.0.progress")).toBeCloseTo(1 / 3);
    expect(self().values.get("Crafting.0.suspended")).toBe(0);

    // 背包塞满 → 到点产出放不下 → 挂起（remaining 0, suspended 1，任务保留）
    Inventory[player]!.slots[0] = { kind: "filler", count: 1 };
    Inventory[player]!.slots[1] = { kind: "filler", count: 1 };
    reach(room).applySnapshot(sim.tick(50));
    expect(self().values.get("Crafting.0.remainingTicks")).toBe(1);
    reach(room).applySnapshot(sim.tick(50));
    expect(self().values.get("Crafting.0.remainingTicks")).toBe(0);
    expect(self().values.get("Crafting.0.progress")).toBe(1);
    expect(self().values.get("Crafting.0.suspended")).toBe(1);
    expect(self().stringValues.get("Crafting.0.recipeId")).toBe("slow");

    // 腾位 → 完成产出；任务条目与动态 key 一并消失
    Inventory[player]!.slots[1] = null;
    reach(room).applySnapshot(sim.tick(50));
    expect(Inventory[player]!.slots.some((s) => s?.kind === "out")).toBe(true);
    expect(self().values.has("Crafting.0.remainingTicks")).toBe(false);
    expect(self().values.has("Crafting.0.progress")).toBe(false);
    expect(self().values.has("Crafting.0.suspended")).toBe(false);
    expect(self().stringValues.has("Crafting.0.recipeId")).toBe(false);
  });
});

describe("批次 C：离线门控回归（⑤）", () => {
  it("断线保留实体从他人 per-client 快照消失", async () => {
    const sim = await createGameSimulation(protocolDef());
    sim.addPlayer("s1");
    const join2 = sim.addPlayer("s2");
    const { room, playerStates } = makeWiredRoom([{ sessionId: "s1", networkId: 1 }]);
    reach(room).sim = sim;

    reach(room).applySnapshot(sim.tick(50));
    expect(playerStates.get("s1")!.visibleEntities.has(String(join2.networkId))).toBe(true);

    sim.removePlayer("s2"); // 默认保留 5 分钟 → 挂 Offline
    reach(room).applySnapshot(sim.tick(50));
    expect(playerStates.get("s1")!.visibleEntities.has(String(join2.networkId))).toBe(false);
  });
});

describe("批次 C：真实 game.json netSync 接线（⑥）", () => {
  it("Structure / Inventory+durability / ItemMeta+durability / Crafting 条目存在", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const fields = def.netSync?.fields ?? [];

    const structure = fields.find((f) => f.component === "Structure");
    expect(structure?.fields).toEqual(["role", "connectLow", "connectHigh", "connectDir"]);

    const inventories = fields.filter((f) => f.component === "Inventory");
    expect(inventories.length).toBe(2);
    for (const entry of inventories) {
      expect(entry.fields).toContain("slots");
      expect(entry.fields).toContain("durability");
    }

    const itemMeta = fields.find((f) => f.component === "ItemMeta");
    expect(itemMeta?.fields).toContain("durability");

    const crafting = fields.find((f) => f.component === "Crafting");
    expect(crafting).toBeDefined();
    expect(crafting!.tags).toEqual(["Player"]);
    expect(crafting!.fields).toEqual(["jobs"]);
  });
});
