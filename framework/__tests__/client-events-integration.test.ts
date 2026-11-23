/**
 * CC-04 客户端事件集成测试（真实 GameSimulation + 真实 game/ 配置）。
 *
 * 覆盖：
 * - A 的攻击（hit）发给 A 与附近 B；远处/跨图玩家收不到；
 * - A 的 craft-complete / gather 只发 A（self），不发给旁边的 B；
 * - death 载荷只有 networkId（无 eid）；
 * - 跨图（EntityMap 不同）的 nearby 事件被过滤。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query } from "bitecs";

import {
  bootstrapFramework,
  createGameSimulation,
  getRegistries,
  loadGameDefinition,
  spawnEntity,
  type SimulationPort,
} from "framework/index";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { Transform } from "framework/components/transform";
import { Inventory } from "framework/components/inventory";
import { EntityMap } from "framework/components/entityMap";
import { Cooldown } from "framework/components/timer";
import { startConfiguredAction } from "framework/simulation/actions/actionSystem";
import { emitEvent } from "framework/events/gameEvents";
import { queueEvent } from "framework/simulation/events/eventBus";
import { harvest } from "framework/systems/gameplay/gatheringSystem";
import type { GameWorld } from "framework/world";
import type { ClientEvent } from "framework/simulation/clientEvents";

beforeAll(() => {
  bootstrapFramework();
});

beforeEach(() => {
  // AoS EntityMap 是进程级单例：清空跨世界/跨用例的 eid 残留。
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

function eventsOf(
  result: ReturnType<SimulationPort["tick"]>,
  sessionId: string,
  type?: string,
): ClientEvent[] {
  const events = result.clientEvents?.get(sessionId) ?? [];
  return type ? events.filter((event) => event.type === type) : events;
}

async function twoPlayers() {
  const sim = await createGameSimulation(loadGameDefinition({ gameJsonPath: "game/game.json" }));
  const world = simWorld(sim);
  const join1 = sim.addPlayer("s1");
  const join2 = sim.addPlayer("s2");
  const p1 = playerEidOf(sim, "s1");
  const p2 = playerEidOf(sim, "s2");

  // 同图、相距 20px（nearby 半径内）。
  EntityMap[p1] = world.defaultMapId;
  EntityMap[p2] = world.defaultMapId;
  Transform.x[p1] = 100;
  Transform.y[p1] = 100;
  Transform.x[p2] = 120;
  Transform.y[p2] = 100;

  return {
    sim,
    world,
    p1,
    p2,
    net1: join1.networkId,
    net2: join2.networkId,
  };
}

describe("CC-04 客户端事件：受众与隐私", () => {
  it("A 的 hit 发给 A 和附近的 B；远处 C（跨图）收不到", async () => {
    const { sim, world, p1, net1, net2 } = await twoPlayers();
    const join3 = sim.addPlayer("s3");
    const p3 = playerEidOf(sim, "s3");
    // C 在另一张图（把玩家 C 放到任意非默认图）。
    const otherMap = [...world.activeMaps].find((mapId) => mapId !== world.defaultMapId);
    expect(otherMap).toBeDefined();
    EntityMap[p3] = otherMap!;
    Transform.x[p3] = 100;
    Transform.y[p3] = 100;

    // 事件在产生时记录锚点；tick 后统一过滤发送。
    queueEvent(world, "on-hit", {
      eid: p1,
      attacker: p1,
      target: p3, // 目标是谁不影响 hit 受众（锚点 = 攻击者）
      damage: 7,
      crit: true,
      damageType: "slash",
    });

    const result = sim.tick(50);
    const hitA = eventsOf(result, "s1", "hit");
    const hitB = eventsOf(result, "s2", "hit");
    const hitC = eventsOf(result, "s3", "hit");

    expect(hitA).toHaveLength(1);
    expect(hitB).toHaveLength(1);
    expect(hitC).toHaveLength(0);
    expect(hitA[0]!.data).toMatchObject({
      attacker: net1,
      target: join3.networkId,
      damage: 7,
      crit: true,
      damageType: "slash",
    });
    expect(hitB[0]!.seq).toBe(hitA[0]!.seq);
    // 载荷只有 networkId：不含任何 eid 字段。
    expect(hitA[0]!.data).not.toHaveProperty("eid");
    expect(hitB[0]!.data).not.toHaveProperty("eid");
  });

  it("A 的 craft-complete / gather 只发给 A，不发给旁边的 B", async () => {
    const { sim, world, p1, p2, net1, net2 } = await twoPlayers();
    expect(net2).toBeGreaterThan(0);

    Inventory[p1] = { capacity: 4, slots: [{ kind: "wood", count: 2 }, null, null, null] };
    const craft = sim.submitCommand("s1", { type: "craft", recipe: "wood_axe" });
    expect(craft.ok).toBe(true);

    // 真实采集路径（rock 无工具门槛）：事件 self，只给采集者。
    const rockEid = spawnEntity(
      world,
      world.archetypes.get("rock"),
      getRegistries().componentRegistry,
      { x: Transform.x[p1] + 8, y: Transform.y[p1] },
    );
    expect(harvest(world, p1, rockEid)).toBe(true);

    const result = sim.tick(50);
    const aCraft = eventsOf(result, "s1", "craft-complete");
    const bCraft = eventsOf(result, "s2", "craft-complete");
    const aGather = eventsOf(result, "s1", "gather");
    const bGather = eventsOf(result, "s2", "gather");

    expect(aCraft).toHaveLength(1);
    expect(aCraft[0]!.data).toMatchObject({ player: net1, recipeId: "wood_axe" });
    expect(bCraft).toHaveLength(0);

    expect(aGather).toHaveLength(1);
    expect(aGather[0]!.data).toMatchObject({ actor: net1, items: [["stone", 1]] });
    expect(bGather).toHaveLength(0);
    // gather 指向的资源节点也是 networkId（不是 eid）。
    expect(aGather[0]!.data.node).toBe(NetworkId.value[rockEid]);
    expect(aGather[0]!.data).not.toHaveProperty("eid");
  });

  it("动作时间轴：action-start/phase/hit/end 发给附近玩家；gather 仍只给本人", async () => {
    const { sim, world, p1, net1 } = await twoPlayers();
    Cooldown.remainingMs[p1] = 0;
    const rockEid = spawnEntity(
      world,
      world.archetypes.get("rock"),
      getRegistries().componentRegistry,
      { x: Transform.x[p1] + 8, y: Transform.y[p1] },
    );
    expect(
      startConfiguredAction(world, p1, "gather", { targetEid: rockEid, maxRange: 64 }),
    ).toBe(true);
    const rockNetworkId = NetworkId.value[rockEid];

    const results = [sim.tick(50)];
    const startA = eventsOf(results[0]!, "s1", "action-start");
    const startB = eventsOf(results[0]!, "s2", "action-start");
    expect(startA).toHaveLength(1);
    expect(startB).toHaveLength(1);
    expect(startA[0]!.data).toMatchObject({
      actionId: "gather",
      actor: net1,
      target: rockNetworkId,
      phase: "windup",
    });

    // gather 10 ticks：windup 3 / swing 6 / recovery 10；第 3 个 tick 进入 swing。
    for (let i = 0; i < 3; i++) results.push(sim.tick(50));
    const phaseA = results.flatMap((result) => eventsOf(result, "s1", "action-phase"));
    const hitA = results.flatMap((result) => eventsOf(result, "s1", "action-hit"));
    const hitB = results.flatMap((result) => eventsOf(result, "s2", "action-hit"));
    const gatherA = results.flatMap((result) => eventsOf(result, "s1", "gather"));
    const gatherB = results.flatMap((result) => eventsOf(result, "s2", "gather"));

    expect(phaseA.length).toBeGreaterThanOrEqual(1);
    expect(phaseA[0]!.data).toMatchObject({
      actionId: "gather",
      actor: net1,
      target: rockNetworkId,
      phase: "swing",
    });
    expect(hitA).toHaveLength(1);
    expect(hitB).toHaveLength(1); // action-hit 是 nearby 表现事件
    expect(hitA[0]!.data).toMatchObject({ actionId: "gather", kind: "harvest" });
    expect(gatherA).toHaveLength(1);
    expect(gatherB).toHaveLength(0); // 产出仍只给本人

    // 剩余 7 tick 到达 durationTicks=10 → action-end。
    const endResults: ReturnType<SimulationPort["tick"]>[] = [];
    for (let i = 0; i < 7; i++) endResults.push(sim.tick(50));
    const endA = endResults.flatMap((result) => eventsOf(result, "s1", "action-end"));
    expect(endA).toHaveLength(1);
    expect(endA[0]!.data).toMatchObject({
      actionId: "gather",
      actor: net1,
      target: rockNetworkId,
    });
  });

  it("map-change：玩家换图发 self 事件（from/to/mapVersion）；地形写回发 map 事件", async () => {
    const { sim, world, p1 } = await twoPlayers();
    const otherMap = [...world.activeMaps].find((mapId) => mapId !== world.defaultMapId)!;

    // 首 tick 只记基线（初始状态由 RoomState 承担），之后换图才发事件。
    sim.tick(50);
    EntityMap[p1] = otherMap;
    const moved = sim.tick(50);
    const mapEvents = eventsOf(moved, "s1", "map-change");
    expect(mapEvents).toHaveLength(1);
    expect(mapEvents[0]!.data).toMatchObject({
      from: world.defaultMapId,
      to: otherMap,
      mapVersion: world.maps[otherMap]!.version,
    });

    // 地形写回：debugSetGround 后 geometry.version 变化 → 同图玩家收到 map 事件。
    const geometry = world.maps[otherMap]!;
    const before = geometry.version;
    expect(sim.debugSetGround?.(otherMap, 0, (geometry.tiles[0] ?? 0) === 0 ? 1 : 0)).toBe(true);
    expect(geometry.version).not.toBe(before);
    const written = sim.tick(50);
    const writeback = eventsOf(written, "s1", "terrain-writeback");
    expect(writeback).toHaveLength(1);
    expect(writeback[0]!.data).toEqual({ mapId: otherMap, version: geometry.version });
  });

  it("debug_colliders：实体碰撞体带 networkId（供客户端与 EntityState.id 关联）", async () => {
    const { sim, world, net1 } = await twoPlayers();
    sim.tick(50); // 碰撞系统登记实体体
    const snapshot = sim.getDebugSnapshot({
      mapId: world.defaultMapId,
    }) as { entityBodies: Array<{ eid?: number; networkId?: number }> };
    expect(snapshot.entityBodies.some((body) => body.networkId === net1)).toBe(true);
  });

  it("death 发送 nearby，victim/killer 均为 networkId；跨图不发送", async () => {
    const { sim, world, p1, p2, net1, net2 } = await twoPlayers();

    emitEvent(world, "killed", { killer: p1, victim: p2, kind: "boar" });
    const near = sim.tick(50);
    const deathA = eventsOf(near, "s1", "death");
    expect(deathA).toHaveLength(1);
    expect(deathA[0]!.data).toEqual({
      victim: net2,
      killer: net1,
      kind: "boar",
      // CC-11：表现事件按 type 挂不透明 id（audio.json / vfx.json）
      sfx: ["sfx_death"],
      vfx: ["vfx_death"],
    });
    expect(deathA[0]!.data).not.toHaveProperty("eid");

    // B 换到另一张图后再死：A 在同图但事件锚点在 B 的新图 → 不发给 A。
    const otherMap = [...world.activeMaps].find((mapId) => mapId !== world.defaultMapId)!;
    EntityMap[p2] = otherMap;
    Transform.x[p2] = 500;
    Transform.y[p2] = 500;
    emitEvent(world, "killed", { killer: p1, victim: p2, kind: "boar" });
    const far = sim.tick(50);
    expect(eventsOf(far, "s1", "death")).toHaveLength(0);
  });
});
