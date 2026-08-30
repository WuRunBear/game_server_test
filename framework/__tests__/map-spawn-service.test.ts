/**
 * 出生服务 + 传送门消费方迁移集成测试（map-system-redesign todo 12）。
 *
 * 覆盖：
 * - I4：random 模式两玩家出生点不同且均合法（可走 + 声明区域内），
 *   且 addPlayer 写入持久化 SpawnPoint（mapId + 像素坐标）；
 * - 持久化出生点：移动后重生回首次出生点（respawnSystem 读 SpawnPoint
 *   而非被移动覆盖的 Transform）；出生规则候选池为空时 error 日志 + 回退
 *   地图几何中心；save→load 往返保留出生点，orphan 复用绑定不重新选点；
 * - I5：portal 触发仅移动触发者（同图另一玩家不动）；目标图 registry key
 *   非法 → error 日志 + 安全跳过（不崩溃、不移动、无静默顶替）。
 *
 * 真实配置开机成本高（155M tick 初始演化），beforeAll 建一次 sim 共享；
 * roundtrip 用例的第二个 sim 走 record.maps 反序列化回填（无生成/演化）。
 * portal 用例手工构造实体（与 per-player-maps-portal.test.ts 同款 harness）。
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import {
  bootstrapFramework,
  loadGameDefinition,
  createGameSimulation,
  createGameInstance,
  createDefaultGameDefinition,
} from "framework/index";
import { serializeWorld } from "framework/persistence/worldSerializer";
import { Transform } from "framework/components/transform";
import { Velocity, Collider, ColliderShape } from "framework/components/physics";
import { Health, Team } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { Inventory } from "framework/components/inventory";
import { Size } from "framework/components/size";
import { EntityMap } from "framework/components/entityMap";
import { SpawnPoint } from "framework/components/spawnPoint";
import { Portal } from "framework/components/portal";
import { walkableAt, regionOf } from "map/geometry/query";
import { deathSystem } from "framework/systems/gameplay/deathSystem";
import { respawnSystem } from "framework/systems/gameplay/respawnSystem";
import { portalSystem } from "framework/systems/gameplay/portalSystem";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import { makeTestGeometry } from "./helpers/mapGeometry";
import type { GameWorld } from "framework/world";
import type { MapGeometry } from "map/geometry/types";
import type { Repository, WorldRecord } from "framework/repository";

beforeAll(() => {
  bootstrapFramework();
});

/** 按 networkId 找 eid（networkId 跨存档保真，eid 不跨 world 稳定）。 */
function eidByNetworkId(world: GameWorld, networkId: number): number {
  const eid = [...query(world, [NetworkId])].find((e) => NetworkId.value[e] === networkId);
  expect(eid).toBeDefined();
  return eid!;
}

/** 断言像素落点合法：所在 tile 可走且属于声明区域。 */
function expectLegalSpawn(
  geometry: MapGeometry,
  pos: { x: number; y: number },
  region: string,
): void {
  const tx = Math.floor(pos.x / geometry.grid.tileWidth);
  const ty = Math.floor(pos.y / geometry.grid.tileHeight);
  expect(walkableAt(geometry, tx, ty)).toBe(true);
  expect(regionOf(geometry, tx, ty)).toBe(region);
}

describe("spawn service（真实配置）", () => {
  let sim: Awaited<ReturnType<typeof createGameSimulation>>;
  let world: GameWorld;
  let gameDef: ReturnType<typeof loadGameDefinition>;

  beforeAll(async () => {
    gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    sim = await createGameSimulation(gameDef);
    world = (sim as unknown as { world: GameWorld }).world;
  }, 30_000);

  it("I4: random 模式两玩家出生点不同且均合法（可走 + 声明区域内）", () => {
    const geometry = world.maps[world.defaultMapId];
    expect(geometry).toBeDefined();
    const rule = gameDef.resolvedPlayerRule?.spawn;
    expect(rule?.mode).toBe("random");
    expect(rule?.region).toBe("beach");

    // Math.random 受控：两次独立选点确定命中不同候选 tile（beach 池 > 1 格）
    const rnd = vi.spyOn(Math, "random").mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);
    const net1 = sim.addPlayer("s-i4-a").networkId;
    const net2 = sim.addPlayer("s-i4-b").networkId;
    rnd.mockRestore();

    const eid1 = eidByNetworkId(world, net1);
    const eid2 = eidByNetworkId(world, net2);
    const pos1 = { x: Transform.x[eid1], y: Transform.y[eid1] };
    const pos2 = { x: Transform.x[eid2], y: Transform.y[eid2] };

    expectLegalSpawn(geometry!, pos1, rule!.region!);
    expectLegalSpawn(geometry!, pos2, rule!.region!);
    expect(pos1).not.toEqual(pos2);

    // 持久化出生点随创建写入（mapId + 落点），与初始 Transform 一致
    expect(SpawnPoint[eid1]).toEqual({ mapId: world.defaultMapId, ...pos1 });
    expect(SpawnPoint[eid2]).toEqual({ mapId: world.defaultMapId, ...pos2 });

    // PlayerState.mapId 同步路径不回归：快照 playerMaps 按会话给出所属图
    const { snapshot } = sim.tick(50);
    expect(snapshot.playerMaps.get("s-i4-a")).toBe(world.defaultMapId);
    expect(snapshot.playerMaps.get("s-i4-b")).toBe(world.defaultMapId);
  });

  it("I4：持久化出生点：移动后重生回首次出生点（读 SpawnPoint 而非 Transform）", () => {
    world.gameDef.resolvedRules["respawn"] = { delayMs: 0 };
    const net = sim.addPlayer("s-respawn").networkId;
    const eid = eidByNetworkId(world, net);
    const spawnPos = { x: Transform.x[eid], y: Transform.y[eid] };
    expect(SpawnPoint[eid]).toEqual({ mapId: world.defaultMapId, ...spawnPos });

    // 远离出生点（模拟移动覆写 Transform）
    Transform.x[eid] = spawnPos.x + 999;
    Transform.y[eid] = spawnPos.y + 999;

    Health.current[eid] = 0;
    deathSystem(world);
    respawnSystem(world);

    expect(Health.current[eid]).toBe(100);
    expect(Transform.x[eid]).toBe(spawnPos.x);
    expect(Transform.y[eid]).toBe(spawnPos.y);
    expect(EntityMap[eid]).toBe(world.defaultMapId);
  });

  it("I4：出生规则候选池为空：error 日志 + 回退地图几何中心（仍写入出生点）", () => {
    const geometry = world.maps[world.defaultMapId]!;
    const center = {
      x: (geometry.grid.width / 2) * geometry.grid.tileWidth,
      y: (geometry.grid.height / 2) * geometry.grid.tileHeight,
    };
    const originalRule = gameDef.resolvedPlayerRule;
    const errorSpy = vi.spyOn(world.logger, "error");
    gameDef.resolvedPlayerRule = { spawn: { mode: "random", region: "no-such-region" } };
    try {
      const net = sim.addPlayer("s-fallback").networkId;
      const eid = eidByNetworkId(world, net);
      expect(Transform.x[eid]).toBe(center.x);
      expect(Transform.y[eid]).toBe(center.y);
      expect(errorSpy).toHaveBeenCalled();
      expect(SpawnPoint[eid]).toEqual({ mapId: world.defaultMapId, ...center });
    } finally {
      gameDef.resolvedPlayerRule = originalRule;
      errorSpy.mockRestore();
    }
  });

  it("I4：出生点随存档往返：save→load 保留 SpawnPoint，orphan 复用绑定不重新选点", async () => {
    // 全部玩家先移出地图范围（+5000 越界）——重选点必落在图内，存档 Transform 必在图外，
    // 恢复后 Transform 保持存档值即证明未重新选点
    const savedByNetworkId = new Map<number, { spawn: { x: number; y: number; mapId: string }; moved: { x: number; y: number } }>();
    for (const eid of [...query(world, [Player])]) {
      const spawn = { ...SpawnPoint[eid]! };
      Transform.x[eid] += 5000;
      Transform.y[eid] += 5000;
      savedByNetworkId.set(NetworkId.value[eid], {
        spawn,
        moved: { x: Transform.x[eid], y: Transform.y[eid] },
      });
    }
    expect(savedByNetworkId.size).toBeGreaterThan(0);

    const record: WorldRecord = serializeWorld(world, "spawn-roundtrip");
    // 序列化层：出生点作为 AoS 组件入档（不在瞬态跳过清单）
    const savedPlayer = record.entities.find((e) => savedByNetworkId.has(e.networkId))!;
    expect(savedPlayer.components["SpawnPoint"]).toBeDefined();

    const repo: Repository = {
      loadWorld: async () => record,
      saveWorld: async () => {},
    };
    const sim2 = await createGameSimulation(gameDef, { repository: repo, saveId: "spawn-roundtrip" });
    const world2 = (sim2 as unknown as { world: GameWorld }).world;

    // 复用绑定：返回 networkId 必是存档玩家之一（新创建会拿到更大的 nextNetworkId）
    const reboundNet = sim2.addPlayer("s-roundtrip-2").networkId;
    const saved = savedByNetworkId.get(reboundNet)!;
    const eid2 = eidByNetworkId(world2, reboundNet);

    expect(SpawnPoint[eid2]).toEqual(saved.spawn);
    expect(Transform.x[eid2]).toBe(saved.moved.x);
    expect(Transform.y[eid2]).toBe(saved.moved.y);
    expect(EntityMap[eid2]).toBe(world.defaultMapId);
  });
});

// —— I5 传送门（手工 harness，与 per-player-maps-portal.test.ts 同款） ——

/** 构造一个最小世界（默认配置，无地图配置兜底路径）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 挂三张图（a/b/c，全部常驻激活）。 */
function attachTestMaps(world: GameWorld): void {
  for (const key of ["a", "b", "c"]) {
    world.maps[key] = makeTestGeometry({ key, width: 8, height: 8 });
    world.activeMaps.add(key);
  }
}

/** 手工构造玩家实体（不经 spawnEntity，组件与 per-player-maps-portal 同款）。 */
function spawnTestPlayer(world: GameWorld, opts: { x?: number; y?: number } = {}): number {
  const id = addEntity(world);
  addComponent(world, id, Transform);
  addComponent(world, id, NetworkId);
  addComponent(world, id, Player);
  addComponent(world, id, Health);
  addComponent(world, id, Team);
  addComponent(world, id, Velocity);
  addComponent(world, id, Collider);
  addComponent(world, id, Size);
  Transform.x[id] = opts.x ?? 0;
  Transform.y[id] = opts.y ?? 0;
  Health.current[id] = 100;
  Health.max[id] = 100;
  Team.id[id] = 1;
  Collider.shape[id] = ColliderShape.Box;
  Collider.halfW[id] = 8;
  Collider.halfH[id] = 8;
  Size.w[id] = 16;
  Size.h[id] = 16;
  Inventory[id] = { capacity: 4, slots: Array.from({ length: 4 }, () => null) };
  NetworkId.value[id] = world.nextNetworkId++;
  setEntityKind(world, id, "test-player");
  return id;
}

/** 手工构造 portal 实体（Transform+Size + Portal AoS + 显式 EntityMap）。 */
function spawnTestPortal(
  world: GameWorld,
  opts: { x: number; y: number; targetMap: string; destX: number; destY: number; mapId: string },
): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, Size);
  Transform.x[eid] = opts.x;
  Transform.y[eid] = opts.y;
  Size.w[eid] = 32;
  Size.h[eid] = 32;
  Portal[eid] = { targetMap: opts.targetMap, x: opts.destX, y: opts.destY };
  EntityMap[eid] = opts.mapId;
  return eid;
}

/** 清空 AoS 模块级单例残留（跨 world 复用 eid，防串扰）。 */
function clearAosSingletons(): void {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
  for (let i = 0; i < Portal.length; i++) Portal[i] = undefined;
  for (let i = 0; i < SpawnPoint.length; i++) SpawnPoint[i] = undefined;
}

describe("portal（registry key 校验）", () => {
  it("I5: 触发者被移动到目标图，同图另一玩家不受影响", () => {
    const world = createBareWorld();
    clearAosSingletons();
    attachTestMaps(world);
    spawnTestPortal(world, { x: 50, y: 50, targetMap: "b", destX: 150, destY: 160, mapId: "a" });
    const trigger = spawnTestPlayer(world, { x: 50, y: 50 });
    EntityMap[trigger] = "a";
    const bystander = spawnTestPlayer(world, { x: 300, y: 300 });
    EntityMap[bystander] = "a";

    portalSystem(world);

    expect(EntityMap[trigger]).toBe("b");
    expect(Transform.x[trigger]).toBe(150);
    expect(Transform.y[trigger]).toBe(160);
    expect(EntityMap[bystander]).toBe("a");
    expect(Transform.x[bystander]).toBe(300);
    expect(Transform.y[bystander]).toBe(300);
  });

  it("I5: 目标图 key 非法 → error 日志、不崩溃、不移动、无静默顶替", () => {
    const world = createBareWorld();
    clearAosSingletons();
    attachTestMaps(world);
    const errorSpy = vi.spyOn(world.logger, "error");
    spawnTestPortal(world, { x: 50, y: 50, targetMap: "nope", destX: 90, destY: 90, mapId: "a" });
    const player = spawnTestPlayer(world, { x: 50, y: 50 });
    EntityMap[player] = "a";

    expect(() => portalSystem(world)).not.toThrow();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[1]).toMatchObject({ targetMap: "nope" });
    expect(EntityMap[player]).toBe("a");
    expect(Transform.x[player]).toBe(50);
    expect(Transform.y[player]).toBe(50);
    // 无静默顶替：目标图不凭空出现，激活集不变
    expect(Object.keys(world.maps).sort()).toEqual(["a", "b", "c"]);
    expect(world.activeMaps).toEqual(new Set(["a", "b", "c"]));
  });
});
