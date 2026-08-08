import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "bitecs";
import { Encoder, Decoder } from "@colyseus/schema";
import { MapSchema, StateView, $filter } from "@colyseus/schema";
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
  createFileRepository,
  PHASE_NIGHT,
} from "framework/index";
import { destroyEntity } from "framework/entities/destroyEntity";
import { PlayerState } from "framework/net/colyseus/state/PlayerState";
import { RoomState } from "framework/net/colyseus/state/RoomState";
import { EntityState } from "framework/net/colyseus/state/EntityState";
import { Transform } from "framework/components/transform";
import { Velocity } from "framework/components/physics";
import { Health } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { Inventory, type InventoryEntry, type ItemStack } from "framework/components/inventory";
import { Needs } from "framework/components/needs";
import { Kind } from "framework/components/kind";
import { LightSource } from "framework/components/lightSource";
import { Placeable } from "framework/components/placeable";
import { CraftingStation } from "framework/components/craftingStation";
import type { GameWorld } from "framework/world";
import type { WorldRecord, ServerRule } from "framework/index";

beforeAll(() => {
  bootstrapFramework();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await sleep(15);
  }
  throw new Error("waitFor 超时");
}

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

function ensureTestArchetypes(world: GameWorld): void {
  ensureArchetype(world, {
    kind: "w1",
    tags: ["Player"],
    components: {
      Size: { w: 16, h: 16 },
      Velocity: {},
      Collider: { shape: 1, halfW: 8, halfH: 8 },
      Health: { current: 100, max: 100 },
      Inventory: { capacity: 3 },
      Needs: [{ name: "n1", current: 80, max: 100, decayPerSec: 1, starveDmg: 1 }],
    },
    team: 1,
  });
  ensureArchetype(world, {
    kind: "c1",
    components: {
      Size: { w: 24, h: 24 },
      Placeable: { footprintW: 24, footprintH: 24, canCollide: 1 },
      LightSource: { radius: 80, fuelRemainingMs: 1e9 },
      CraftingStation: { stationType: 1 },
    },
  });
}

function fillInventory(inv: InventoryEntry, stacks: ItemStack[]): void {
  inv.slots = Array.from({ length: inv.capacity }, () => null);
  stacks.forEach((s, i) => {
    inv.slots[i] = { ...s };
  });
}

function simWorld(sim: ReturnType<typeof createGameSimulation>): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

describe("Slice 5：世界快照序列化/恢复", () => {
  it("serializeWorld：全实体全字段（SoA + AoS + world 级），瞬态组件缺席", () => {
    const world = createBareWorld();
    ensureTestArchetypes(world);
    const w = spawnEntity(world, world.archetypes.get("w1"), getRegistries().componentRegistry, { x: 12, y: 34 });
    Inventory[w]!.slots[0] = { kind: "k1", count: 5 };
    Health.current[w] = 42;
    Needs[w]![0]!.current = 33;
    spawnEntity(world, world.archetypes.get("c1"), getRegistries().componentRegistry, { x: 5, y: 6 });
    world.time.tick = 77;
    world.time.timeOfDay = { hour: 21.5, phase: PHASE_NIGHT };
    world.nextNetworkId = 100;

    const record = serializeWorld(world, "s1");
    expect(record.tick).toBe(77);
    expect(record.nextNetworkId).toBe(100);
    expect(record.timeOfDay).toEqual({ hour: 21.5, phase: 1 });
    expect(record.entities.length).toBe(2);

    const ws = record.entities.find((e) => e.kind === "w1")!;
    expect(ws.networkId).toBe(NetworkId.value[w]);
    expect(ws.components["Transform"]).toEqual({ x: 12, y: 34, rot: 0, scale: 0 });
    expect(ws.components["Health"]).toEqual({ current: 42, max: 100 });
    expect(ws.components["Inventory"]).toEqual({ capacity: 3, slots: [{ kind: "k1", count: 5 }, null, null] });
    expect(ws.components["Needs"]).toEqual([{ name: "n1", current: 33, max: 100, decayPerSec: 1, starveDmg: 1 }]);
    // 瞬态组件不入存档
    expect(ws.components["Velocity"]).toBeUndefined();
    expect(ws.components["Intent"]).toBeUndefined();
    expect(ws.components["Kind"]).toBeUndefined();

    const cs = record.entities.find((e) => e.kind === "c1")!;
    expect(cs.components["LightSource"]).toEqual({ radius: 80, fuelRemainingMs: 1e9 });
    expect(cs.components["Placeable"]).toEqual({ footprintW: 24, footprintH: 24, canCollide: 1, ownerNetworkId: 0 });

    // 存档必须为纯 JSON（可安全序列化）
    expect(() => JSON.parse(JSON.stringify(record))).not.toThrow();
  });

  it("restoreWorld：重建实体（networkId/坐标/AoS 一致），清空初始实体，返回玩家 eid", () => {
    const world1 = createBareWorld();
    ensureTestArchetypes(world1);
    const w = spawnEntity(world1, world1.archetypes.get("w1"), getRegistries().componentRegistry, { x: 12, y: 34 });
    Inventory[w]!.slots[0] = { kind: "k1", count: 5 };
    Health.current[w] = 42;
    spawnEntity(world1, world1.archetypes.get("c1"), getRegistries().componentRegistry, { x: 5, y: 6 });
    world1.time.tick = 77;
    world1.time.timeOfDay = { hour: 21.5, phase: PHASE_NIGHT };
    world1.nextNetworkId = 100;
    const record = serializeWorld(world1, "s1");

    const world2 = createBareWorld();
    const orphan = restoreWorld(world2, record);

    // 玩家实体进入复用队列
    expect(orphan.length).toBe(1);
    const orphanEid = orphan[0];
    expect(Kind[orphanEid]).toBe("w1");

    expect(world2.time.tick).toBe(77);
    expect(world2.time.timeOfDay).toEqual({ hour: 21.5, phase: 1 });
    expect(world2.nextNetworkId).toBe(100);

    const eids = query(world2, [NetworkId]);
    expect(eids.length).toBe(2);
    const w2 = eids.find((e) => Kind[e] === "w1")!;
    expect(NetworkId.value[w2]).toBe(record.entities.find((e) => e.kind === "w1")!.networkId);
    expect(Transform.x[w2]).toBe(12);
    expect(Transform.y[w2]).toBe(34);
    expect(Health.current[w2]).toBe(42);
    expect(Inventory[w2]!.slots[0]).toEqual({ kind: "k1", count: 5 });
    const c2 = eids.find((e) => Kind[e] === "c1")!;
    expect(LightSource.radius[c2]).toBe(80);
  });

  it("restoreWorld：未知 kind 跳过不崩溃，world 被清空", () => {
    const world = createBareWorld();
    const record: WorldRecord = {
      id: "s",
      savedAt: 1,
      tick: 1,
      nextNetworkId: 5,
      entities: [{ networkId: 1, kind: "ghost", components: {} }],
    };
    const orphan = restoreWorld(world, record);
    expect(orphan).toEqual([]);
    expect(query(world, [NetworkId]).length).toBe(0);
  });
});

describe("Slice 5：持久化（定时存档 + 读档恢复 + 玩家复用）", () => {
  it("定时存档：达间隔写盘，未达不写；无规则不自动存档", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s5-autosave-"));
    const def = createDefaultGameDefinition();
    def.resolvedRules["server"] = { saveId: "s1", saveIntervalMs: 100 };

    const repo = createFileRepository(dir);
    const sim = createGameSimulation(def, { repository: repo, saveId: "s1" });
    sim.addPlayer("s1");
    sim.tick(50); // 累计 50 < 100，不触发
    await sleep(20);
    expect(await repo.loadWorld("s1")).toBeNull();

    sim.tick(50); // 累计 100 ≥ 100，触发写盘（fire-and-forget）
    await waitFor(async () => (await repo.loadWorld("s1")) !== null);
    const record = await repo.loadWorld("s1");
    expect(record!.id).toBe("s1");
    expect(record!.entities.length).toBe(1);
  });

  it("读档恢复 + addPlayer 复用绑定（networkId/背包保留）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s5-restore-"));
    const def = createDefaultGameDefinition();
    def.resolvedRules["server"] = { saveId: "s1", saveIntervalMs: 100 };

    const repo = createFileRepository(dir);
    const sim1 = createGameSimulation(def, { repository: repo, saveId: "s1" });
    sim1.addPlayer("s1");
    const world1 = simWorld(sim1);
    const p1 = query(world1, [Player])[0];
    Inventory[p1]!.slots[0] = { kind: "k1", count: 7 };
    const savedNid = NetworkId.value[p1];
    sim1.tick(100);
    await waitFor(async () => (await repo.loadWorld("s1")) !== null);

    const record = (await repo.loadWorld("s1"))!;
    const sim2 = createGameSimulation(def, { repository: repo, saveId: "s1", initialRecord: record });
    expect(sim2.addPlayer("s1").networkId).toBe(savedNid);

    const world2 = simWorld(sim2);
    const p2 = query(world2, [Player])[0];
    expect(NetworkId.value[p2]).toBe(savedNid);
    expect(Inventory[p2]!.slots[0]).toEqual({ kind: "k1", count: 7 });
  });

  it("无 server 规则 / 无 repository：tick 正常，不存档不报错", async () => {
    const def = createDefaultGameDefinition();
    const sim = createGameSimulation(def);
    sim.addPlayer("s1");
    const result = sim.tick(50);
    expect(result.tick).toBe(1);
  });
});

describe("Slice 5：兴趣管理（视野裁剪）", () => {
  it("interest：own 恒可见，范围内实体可见，范围外不可见；无规则为 undefined", () => {
    const def = createDefaultGameDefinition();
    def.resolvedRules["server"] = { viewRadius: 100 };
    const sim = createGameSimulation(def);
    const world = simWorld(sim);
    sim.addPlayer("s1");
    sim.addPlayer("s2");
    const [e1, e2] = query(world, [Player]);
    Transform.x[e1] = 0;
    Transform.y[e1] = 0;
    Transform.x[e2] = 300;
    Transform.y[e2] = 300;
    ensureTestArchetypes(world);
    const c1 = spawnEntity(world, world.archetypes.get("c1"), getRegistries().componentRegistry, { x: 10, y: 0 });

    const { interest } = sim.tick(50);
    expect(interest).toBeDefined();

    const i1 = interest!.get("s1")!;
    expect(i1).toContain(NetworkId.value[e1]); // own 恒可见
    expect(i1).toContain(NetworkId.value[c1]); // 建筑在视野内
    expect(i1).not.toContain(NetworkId.value[e2]); // 其他玩家在视野外

    const i2 = interest!.get("s2")!;
    expect(i2).toContain(NetworkId.value[e2]);
    expect(i2).not.toContain(NetworkId.value[e1]);
    expect(i2).not.toContain(NetworkId.value[c1]);
  });

  it("interest：玩家靠近后互见", () => {
    const def = createDefaultGameDefinition();
    def.resolvedRules["server"] = { viewRadius: 100 };
    const sim = createGameSimulation(def);
    const world = simWorld(sim);
    sim.addPlayer("s1");
    sim.addPlayer("s2");
    const [e1, e2] = query(world, [Player]);
    Transform.x[e1] = 0;
    Transform.y[e1] = 0;
    Transform.x[e2] = 50;
    Transform.y[e2] = 0;

    const { interest } = sim.tick(50);
    expect(interest!.get("s1")!).toContain(NetworkId.value[e2]);
    expect(interest!.get("s2")!).toContain(NetworkId.value[e1]);
  });

  it("无 server 规则：interest 为 undefined", () => {
    const def = createDefaultGameDefinition();
    const sim = createGameSimulation(def);
    sim.addPlayer("s1");
    const { interest } = sim.tick(50);
    expect(interest).toBeUndefined();
  });
});

describe("Slice 5：输入校验（anti-cheat）", () => {
  it("超速输入被拒（不写 Velocity）；合法输入通过", () => {
    const def = createDefaultGameDefinition();
    def.resolvedRules["server"] = { maxMoveSpeed: 100 };
    const sim = createGameSimulation(def);
    const world = simWorld(sim);
    sim.addPlayer("s1");
    const p = query(world, [Player])[0];

    // speed 200 > 100 → 拒
    sim.submitInput("s1", { seq: 1, moveX: 0, moveY: 200 });
    sim.tick(50);
    expect(Velocity.vx[p]).toBe(0);
    expect(Velocity.vy[p]).toBe(0);

    // speed 100 ≤ 100 → 通过
    sim.submitInput("s1", { seq: 2, moveX: 60, moveY: 80 });
    sim.tick(50);
    expect(Velocity.vx[p]).toBe(60);
    expect(Velocity.vy[p]).toBe(80);
  });

  it("命令频率超限被拒；窗口推进后放行", () => {
    const def = createDefaultGameDefinition();
    def.resolvedRules["server"] = { maxCommandsPerSec: 2 };
    const sim = createGameSimulation(def);
    const world = simWorld(sim);
    sim.addPlayer("s1");
    const p = query(world, [Player])[0];
    Inventory[p] = { capacity: 4, slots: [{ kind: "k1", count: 1 }, { kind: "k2", count: 1 }, null, null] };

    // 同一 tick 内第 3 条被限流
    expect(sim.submitCommand("s1", { type: "transfer", slot: 0, toSlot: 1 })).toBe(true);
    expect(sim.submitCommand("s1", { type: "transfer", slot: 1, toSlot: 0 })).toBe(true);
    expect(sim.submitCommand("s1", { type: "transfer", slot: 0, toSlot: 1 })).toBe(false);

    // 推进 tick 窗口（1 秒 = tickRate 个 tick）后放行
    for (let i = 0; i < 25; i++) sim.tick(50);
    expect(sim.submitCommand("s1", { type: "transfer", slot: 1, toSlot: 0 })).toBe(true);
  });

  it("无 server 规则：输入与命令全部放行", () => {
    const def = createDefaultGameDefinition();
    const sim = createGameSimulation(def);
    const world = simWorld(sim);
    sim.addPlayer("s1");
    const p = query(world, [Player])[0];
    Inventory[p] = { capacity: 2, slots: [{ kind: "k1", count: 1 }, null] };

    sim.submitInput("s1", { seq: 1, moveX: 9999, moveY: 9999 });
    sim.tick(50);
    expect(Velocity.vx[p]).toBe(9999);
    expect(sim.submitCommand("s1", { type: "transfer", slot: 0, toSlot: 1 })).toBe(true);
  });
});

describe("Slice 5：真实 game 配置（server 规则 + 存档→恢复 demo）", () => {
  it("server 规则解析 + 存档恢复：campfire 与玩家背包俱在", async () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    def.resolvedSpawns = [];
    const server = def.resolvedRules["server"] as ServerRule;
    expect(server.saveId).toBe("main");
    expect(server.viewRadius).toBe(300);
    expect(server.maxMoveSpeed!).toBe(200);
    expect(server.maxCommandsPerSec!).toBe(20);

    const dir = mkdtempSync(join(tmpdir(), "s5-real-"));
    const repo = createFileRepository(dir);
    const sim1 = createGameSimulation(def, { repository: repo, saveId: server.saveId });
    const world1 = simWorld(sim1);
    sim1.addPlayer("s1");
    const p1 = query(world1, [Player])[0];
    Inventory[p1]!.slots[0] = { kind: "campfire_kit", count: 1 };
    const fire = spawnEntity(world1, world1.archetypes.get("campfire"), getRegistries().componentRegistry, { x: 30, y: 0 });
    sim1.tick(50);

    await repo.saveWorld(serializeWorld(world1, server.saveId!));
    const record = (await repo.loadWorld(server.saveId!))!;
    expect(record.entities.some((e) => e.kind === "campfire")).toBe(true);

    const sim2 = createGameSimulation(def, { repository: repo, saveId: server.saveId, initialRecord: record });
    expect(sim2.addPlayer("s1").networkId).toBe(NetworkId.value[p1]);

    const world2 = simWorld(sim2);
    const fires = query(world2, [LightSource]);
    expect(fires.length).toBe(1);
    expect(NetworkId.value[fires[0]]).toBe(NetworkId.value[fire]);
    const p2 = query(world2, [Player])[0];
    expect(Inventory[p2]!.slots[0]).toEqual({ kind: "campfire_kit", count: 1 });
  });
});

describe("Slice 5：审查修复（destroyEntity / 存档防御 / 写盘串行 / per-client filter）", () => {
  it("destroyEntity：清除 AoS 残留（Inventory 等），防 eid 复用后污染存档", () => {
    const world = createBareWorld();
    ensureTestArchetypes(world);
    const w = spawnEntity(world, world.archetypes.get("w1"), getRegistries().componentRegistry, { x: 0, y: 0 });
    expect(Inventory[w]).toBeDefined();
    expect(Needs[w]).toBeDefined();

    destroyEntity(world, w);

    expect(Inventory[w]).toBeUndefined();
    expect(Needs[w]).toBeUndefined();
    expect(Kind[w]).toBeUndefined();
    expect(query(world, [NetworkId])).not.toContain(w);
  });

  it("removePlayer 后存档不含玩家实体（含 AoS 残留清理）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s5-remove-"));
    const def = createDefaultGameDefinition();
    def.resolvedRules["server"] = { saveId: "s1", saveIntervalMs: 100 };
    const repo = createFileRepository(dir);
    const sim = createGameSimulation(def, { repository: repo, saveId: "s1" });
    sim.addPlayer("s1");
    const world = simWorld(sim);
    const p = query(world, [Player])[0];
    Inventory[p] = { capacity: 2, slots: [{ kind: "k1", count: 3 }, null] };
    sim.tick(50);

    sim.removePlayer("s1");
    const record = serializeWorld(world, "s1");
    expect(record.entities.length).toBe(0);
    expect(Inventory[p]).toBeUndefined();
  });

  it("restoreWorld：畸形存档（entities 非数组）不抛错，恢复空世界", () => {
    const world = createBareWorld();
    const orphan = restoreWorld(world, { id: "s", savedAt: 1, tick: 5, nextNetworkId: 9 } as unknown as WorldRecord);
    expect(orphan).toEqual([]);
    expect(query(world, [NetworkId]).length).toBe(0);
    expect(world.time.tick).toBe(5);
  });

  it("fileRepository：损坏 JSON 返回 null；并发写盘串行化，最终为后写内容", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s5-serial-"));
    await writeFile(join(dir, "bad.json"), "{not-json", "utf8");
    const repo = createFileRepository(dir);
    expect(await repo.loadWorld("bad")).toBeNull();

    const p1 = repo.saveWorld({
      id: "w", savedAt: 1, tick: 1, nextNetworkId: 2,
      entities: [{ networkId: 1, kind: "a", components: { Transform: { x: 1, y: 1, rot: 0, scale: 0 } } }],
    });
    const p2 = repo.saveWorld({
      id: "w", savedAt: 2, tick: 2, nextNetworkId: 3,
      entities: [{ networkId: 2, kind: "b", components: { Transform: { x: 2, y: 2, rot: 0, scale: 0 } } }],
    });
    await Promise.all([p1, p2]);

    const record = await repo.loadWorld("w");
    expect(record!.savedAt).toBe(2);
    expect(record!.entities[0].networkId).toBe(2);
  });

  it("PlayerState.visibleEntities 的 $filter：仅所属玩家 sessionId 可见", () => {
    const ps = new PlayerState();
    ps.sessionId = "s1";
    ps.visibleEntities.ownerSessionId = "s1";

    const viewA = new StateView();
    (viewA as unknown as { sessionId?: string }).sessionId = "s1";
    const viewB = new StateView();
    (viewB as unknown as { sessionId?: string }).sessionId = "s2";

    const ctor = ps.visibleEntities.constructor as typeof MapSchema & {
      [key: symbol]: (ref: unknown, index: number, view: StateView | undefined) => boolean;
    };
    const filter = ctor[$filter] as (ref: unknown, index: number, view: StateView | undefined) => boolean;
    expect(filter(ps.visibleEntities, 0, viewA)).toBe(true);
    expect(filter(ps.visibleEntities, 0, viewB)).toBe(false);
    expect(filter(ps.visibleEntities, 0, undefined)).toBe(false);
  });

  it("兴趣裁剪编码链路回归：共享通路不崩 + 最小视图 + join 后实体进出视野", () => {
    const libWarnings: string[] = [];
    const origWarn = console.warn;
    const origErr = console.error;
    console.warn = (...a: unknown[]) => libWarnings.push(a.map(String).join(" ").slice(0, 120));
    console.error = (...a: unknown[]) => libWarnings.push(a.map(String).join(" ").slice(0, 120));

    try {
      const state = new RoomState();

      const playerA = new PlayerState();
      playerA.sessionId = "sA";
      playerA.entityId = 1;
      playerA.visibleEntities.ownerSessionId = "sA";
      state.players.set("sA", playerA);

      const playerB = new PlayerState();
      playerB.sessionId = "sB";
      playerB.entityId = 2;
      playerB.visibleEntities.ownerSessionId = "sB";
      const entB = new EntityState();
      entB.id = 2;
      entB.values.set("Transform.x", 200);
      playerB.visibleEntities.set("2", entB);
      state.players.set("sB", playerB);

      const encoder = new Encoder(state);
      const buffer = new Uint8Array(Encoder.BUFFER_SIZE);
      const sharedIt = { offset: 1 };

      // 共享编码通路（view=undefined）——回归点：旧实现 $filter 读 view.sessionId 抛 TypeError
      expect(() => encoder.encodeAll(sharedIt, buffer)).not.toThrow();

      // per-client 通路：最小视图 = 只挂自己的 PlayerState 树（GameRoom.onJoin 同款接线）
      const viewA = new StateView();
      (viewA as unknown as { sessionId?: string }).sessionId = "sA";
      viewA.add(playerA);

      const itA = { offset: sharedIt.offset };
      const bytesA = encoder.encodeAllView(viewA, sharedIt.offset, itA, buffer);

      const decoded = new RoomState();
      const decoder = new Decoder(decoded);
      decoder.decode(bytesA);

      const decodedA = decoded.players.get("sA");
      const decodedB = decoded.players.get("sB");
      // 自己的 PlayerState 可见、B 的 sessionId 经共享通路可见、B 的 visibleEntities 被过滤
      expect(decodedA?.sessionId).toBe("sA");
      expect(decodedB?.sessionId).toBe("sB");
      expect(decodedB?.visibleEntities.has("2")).toBe(false);

      // —— join 之后实体进入视野：set 挂 state 后必须 view.add（缺此步内容不编码）——
      const ent1 = new EntityState();
      ent1.id = 11;
      ent1.values.set("Transform.x", 150);
      playerA.visibleEntities.set("11", ent1);
      viewA.add(ent1);

      const itP1 = { offset: 1 };
      encoder.encode(itP1);
      const sharedOffset = itP1.offset;
      const patch1 = encoder.encodeView(viewA, sharedOffset, itP1);
      decoder.decode(patch1);
      expect(decodedA?.visibleEntities.get("11")?.values.get("Transform.x")).toBe(150);

      // —— 实体移动：同实例字段更新经 patch 到达 ——
      ent1.values.set("Transform.x", 250);
      const itP2 = { offset: 1 };
      encoder.encode(itP2);
      const patch2 = encoder.encodeView(viewA, itP2.offset, itP2);
      decoder.decode(patch2);
      expect(decodedA?.visibleEntities.get("11")?.values.get("Transform.x")).toBe(250);

      // —— 实体离开视野：view.remove + 删表项 ——
      viewA.remove(ent1);
      playerA.visibleEntities.delete("11");
      const itP3 = { offset: 1 };
      encoder.encode(itP3);
      const patch3 = encoder.encodeView(viewA, itP3.offset, itP3);
      decoder.decode(patch3);
      expect(decodedA?.visibleEntities.has("11")).toBe(false);

      // 全程不允许解码器告警（"refId not found" / "field not defined" 类）
      expect(libWarnings).toEqual([]);
    } finally {
      console.warn = origWarn;
      console.error = origErr;
    }
  });
});
