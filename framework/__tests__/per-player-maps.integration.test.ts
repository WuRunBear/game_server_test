/**
 * Todo 17 集成测试：真实 game/ 配置驱动的 per-player 地图全链路。
 *
 * 用 loadGameDefinition("game/game.json") + createGameSimulation 起真配置仿真，
 * 六段场景断言（对应任务书 T17）：
 *  1. sA 触发 portal 进 cave → sB 仍留 generated-map，跨图不可见（interest 差集）；
 *  2. cave 激活后按 entity-rules 的 cave 规则独立刷出实体（其生态与默认图无关）；
 *  3. sB 随后触发同一 portal 进 cave → 与 sA 同图共享生态（互相可见）；
 *  4. sA 经 cave 回传 portal 返回 generated-map → 空 cave 继续按规则刷怪（常驻模拟）；
 *  5. 存档/读档 roundtrip：两玩家分处两图，恢复 + addPlayer 后 playerMaps 与存前一致；
 *  6. 长程 tick 基线：无异常，任意帧 generated-map 玩家都看不到 cave 实体（无跨图泄漏）。
 *
 * 断言只用公开 DTO（TickResult.snapshot / interest / playerMaps）；
 * SETUP 允许 bracket-access 内部（sim.world / Transform 直接定位置），
 * 传送门定位经 populations 规则刷出后从 ECS 世界查找。
 */
import type { SimulationPort } from "simulation";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createGameSimulation,
  loadGameDefinition,
  createFileRepository,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { Collider } from "framework/components/physics";
import { Portal } from "framework/components/portal";
import { EntityMap, entityMapOf } from "framework/components/entityMap";
import type { GameWorld } from "framework/world";
import type { MapGeometry } from "map/geometry/types";
import type { TickResult } from "framework/simulation/types";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

beforeEach(() => {
  // T5/T10 跨用例陷阱：Portal / EntityMap 是模块级 AoS 单例（eid 跨世界复用，
  // 每个用例新建 world 后 eid 从 1 重新分配）——不清残留会让「玩家的 eid 命中
  // 旧用例的 portal 条目」被 portalSystem 自触发移动。必须在建 sim 之前清空。
  Portal.length = 0;
  EntityMap.length = 0;
});

// ---- 来自真实 game 配置的取值（非框架内硬编码语义） ----
const GAME_JSON = "game/game.json";
/** game/maps/registry.json 的 default 地图键。 */
const DEFAULT_MAP_ID = "island";
/** game/maps/registry.json 的 cave 地图键。 */
const CAVE_MAP_ID = "cave";
/** game/entities/portal.json：入口传送门的目的地（cave 内坐标，回程门邻近格）。 */
const ENTRY_DEST = { x: 488, y: 520 };
/** game/rules/server.json 存了 60s 的 saveIntervalMs，超出测试时长——见 it5。 */
const SAVE_ID = "main";
const TICK_MS = 50;

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

/** 按稳定网络标识找玩家 eid（每个它用例内 addPlayer 顺序固定）。 */
function playerEidByNetworkId(world: GameWorld, networkId: number): number {
  return query(world, [NetworkId]).find((eid) => NetworkId.value[eid] === networkId)!;
}

/** 按地图 + 目标图 find 传送门 eid（populations 规则刷出的 portal / portal_back）。 */
function findPortal(world: GameWorld, mapId: string, targetMap: string): number | undefined {
  return query(world, [Transform]).find((eid) => {
    const state = Portal[eid];
    return state !== undefined && entityMapOf(world, eid) === mapId && state.targetMap === targetMap;
  });
}

/** tile 中心像素坐标是否落在可走格（grid 确定性，seed 固定）。 */
function isWalkableAt(geometry: MapGeometry, x: number, y: number): boolean {
  const g = geometry.grid;
  const tx = Math.floor(x / g.tileWidth);
  const ty = Math.floor(y / g.tileHeight);
  if (tx < 1 || ty < 1 || tx >= g.width - 1 || ty >= g.height - 1) return false;
  return geometry.walkable[ty * g.width + tx] === 1;
}

/**
 * 在传送门邻域找一个「玩家站上去不会被推离触发 AABB」的点：
 * - 偏置距离 ≤ portal 半宽 16 + 玩家半宽 8 = 24（AABB 相交条件，portal/player
 *   均为 config 尺寸 32×32 / 16×16——从 game/entities 配置读取语义，不硬编码）；
 * - 该点 tile 必须可走（否则碰撞系统会把玩家从墙里推出）；
 * - 附近 50px 内不得有其它 Collider 实体（NPC/boar/campfire 会推开玩家导致触发失败）。
 *
 * © 返回 null 表示邻域全被占用（概率趋零：候选 12 个 + 调用方重试）。
 */
function findTriggerSpot(world: GameWorld, portalEid: number, playerEid: number): { x: number; y: number } | null {
  const portalMap = entityMapOf(world, portalEid);
  const runtime = world.maps[portalMap]!;
  const px = Transform.x[portalEid];
  const py = Transform.y[portalEid];
  const bodies = query(world, [Collider, Transform]);
  const offsets: ReadonlyArray<readonly [number, number]> = [
    [0, 0], [12, 0], [-12, 0], [0, 12], [0, -12],
    [12, 12], [12, -12], [-12, 12], [-12, -12],
    [18, 0], [-18, 0], [0, 18], [0, -18],
  ];
  for (const [dx, dy] of offsets) {
    const x = px + dx;
    const y = py + dy;
    if (!isWalkableAt(runtime, x, y)) continue;
    let clear = true;
    for (const body of bodies) {
      if (body === playerEid) continue;
      const d = Math.hypot(Transform.x[body] - x, Transform.y[body] - y);
      if (d < 50) { clear = false; break; }
    }
    if (clear) return { x, y };
  }
  return null;
}

/**
 * 把指定玩家放到传送门上触发一次 portalSystem（每次尝试：选位 → 定坐标 →
 * tick 一帧 → 检查目标图；相邻实体存在导致触发失败时重试）。
 *
 * @returns 触发成功的那次 TickResult（其 snapshot 即「触发后当帧」状态）。
 */
function crossPortal(
  world: GameWorld,
  sim: SimulationPort,
  portalEid: number,
  playerEid: number,
  expectMapId: string,
): TickResult {
  for (let attempt = 0; attempt < 6; attempt++) {
    const spot = findTriggerSpot(world, portalEid, playerEid);
    if (spot) {
      Transform.x[playerEid] = spot.x;
      Transform.y[playerEid] = spot.y;
    }
    const result = sim.tick(TICK_MS);
    if (entityMapOf(world, playerEid) === expectMapId) return result;
  }
  throw new Error(
    `portal 触发失败：玩家 eid=${playerEid} 未能在 6 次尝试内进入地图 "${expectMapId}"`,
  );
}

/** 快照中归属某地图的实体数（公开 DTO——每个实体快照都含 mapId）。 */
function countMapEntities(result: TickResult, mapId: string): number {
  let count = 0;
  for (const snap of result.snapshot.entities.values()) {
    if (snap.mapId === mapId) count++;
  }
  return count;
}

/** 建真配置仿真 + 加两玩家 + 首 tick（让 populations 规则刷出 portal 与资源）。 */
async function setupTwoPlayers(): Promise<{
  def: ReturnType<typeof loadGameDefinition>;
  sim: SimulationPort;
  world: GameWorld;
  eA: number;
  eB: number;
  nidA: number;
  nidB: number;
}> {
  const def = loadGameDefinition({ gameJsonPath: GAME_JSON });
  const sim = await createGameSimulation(def);
  const world = simWorld(sim);
  const nidA = sim.addPlayer("sA").networkId;
  const nidB = sim.addPlayer("sB").networkId;
  const eA = playerEidByNetworkId(world, nidA);
  const eB = playerEidByNetworkId(world, nidB);
  // 两名玩家出生在默认图（buildSnapshot 的 playerMaps 即公开 DTO）
  const first = sim.tick(TICK_MS);
  expect(first.snapshot.playerMaps.get("sA")).toBe(DEFAULT_MAP_ID);
  expect(first.snapshot.playerMaps.get("sB")).toBe(DEFAULT_MAP_ID);
  return { def, sim, world, eA, eB, nidA, nidB };
}

// ============================================================================
describe("per-player integration", () => {
  it("场景1：sA 触发 portal 进 cave；sB 留 generated-map；跨图不可见", async () => {
    const { sim, world, eA, eB, nidA, nidB } = await setupTwoPlayers();

    const portal = findPortal(world, DEFAULT_MAP_ID, CAVE_MAP_ID);
    expect(portal).toBeDefined();

    // sA 触发入口传送门（定位与走位是 SETUP 对内部的操纵；断言全走公开 DTO）
    const triggered = crossPortal(world, sim, portal!, eA, CAVE_MAP_ID);

    // sA 已换图，sB 未被动过
    expect(triggered.snapshot.playerMaps.get("sA")).toBe(CAVE_MAP_ID);
    expect(triggered.snapshot.playerMaps.get("sB")).toBe(DEFAULT_MAP_ID);

    // 快照实体归属：A 的 mapId=cave，B 的 mapId=generated-map
    expect(triggered.snapshot.entities.get(nidA)?.mapId).toBe(CAVE_MAP_ID);
    expect(triggered.snapshot.entities.get(nidB)?.mapId).toBe(DEFAULT_MAP_ID);

    // sA 落点 = portal.json 的传送目标（换成 cave 内坐标）
    expect(triggered.snapshot.entities.get(nidA)?.values["Transform.x"]).toBe(ENTRY_DEST.x);
    expect(triggered.snapshot.entities.get(nidA)?.values["Transform.y"]).toBe(ENTRY_DEST.y);

    // 跨图不可见：两玩家 interest 互不包含对方 networkId
    expect(triggered.interest).toBeDefined();
    expect(triggered.interest!.get("sA")).not.toContain(nidB);
    expect(triggered.interest!.get("sB")).not.toContain(nidA);
    // own 恒可见（各自仍在自己的 interest 中）
    expect(triggered.interest!.get("sA")).toContain(nidA);
    expect(triggered.interest!.get("sB")).toContain(nidB);
  });

  it("场景2：cave 激活后按 cave 规则独立刷出（生态与默认图无关）", async () => {
    const { sim, world, eA, nidA } = await setupTwoPlayers();

    const portal = findPortal(world, DEFAULT_MAP_ID, CAVE_MAP_ID);
    expect(portal).toBeDefined();
    const entered = crossPortal(world, sim, portal!, eA, CAVE_MAP_ID);
    // 进图当帧：cave 里只有 sA 自己（刷怪系统在本 tick 已先于 portal 执行）
    const atEntry = countMapEntities(entered, CAVE_MAP_ID);
    expect(entered.snapshot.playerMaps.get("sA")).toBe(CAVE_MAP_ID);

    // 推进若干 tick（cave 生态已由开机初始演化铺满 max，运行期保持稳定）
    let result = entered;
    for (let i = 0; i < 60; i++) {
      result = sim.tick(TICK_MS);
    }
    const caveCount = countMapEntities(result, CAVE_MAP_ID);
    // cave 生态存在（berry_bush/tree/rock/boar 由 cave 规则铺放，归属 cave）
    expect(caveCount).toBeGreaterThanOrEqual(3);
    // sA 仍在 cave（生态持续运行不把玩家挤走）
    expect(result.snapshot.playerMaps.get("sA")).toBe(CAVE_MAP_ID);
    // 默认图玩家仍留在默认图（sB 从未触发）
    expect(result.snapshot.playerMaps.get("sB")).toBe(DEFAULT_MAP_ID);
    // cave 生态不出现在 sB（默认图玩家）的 interest 里：跨图零泄漏
    for (const [nid, snap] of result.snapshot.entities) {
      if (snap.mapId === CAVE_MAP_ID) {
        expect(result.interest!.get("sB")).not.toContain(nid);
      }
    }
  });

  it("场景3：sB 随后进 cave，与 sA 共享生态（同图互相可见）", async () => {
    const { sim, world, eA, eB, nidA, nidB } = await setupTwoPlayers();

    const portal = findPortal(world, DEFAULT_MAP_ID, CAVE_MAP_ID);
    expect(portal).toBeDefined();
    crossPortal(world, sim, portal!, eA, CAVE_MAP_ID);

    // sB 触发同一入口传送门（此刻 sA 在 cave 的传送落点待着）
    const result = crossPortal(world, sim, portal!, eB, CAVE_MAP_ID);

    // 两玩家现在都在 cave
    expect(result.snapshot.playerMaps.get("sA")).toBe(CAVE_MAP_ID);
    expect(result.snapshot.playerMaps.get("sB")).toBe(CAVE_MAP_ID);

    // 同图互见（viewRadius=300px，两人落点距离远小于半径——共享传送落点）
    expect(result.interest!.get("sA")).toContain(nidB);
    expect(result.interest!.get("sB")).toContain(nidA);
    // 各自 own 恒可见
    expect(result.interest!.get("sA")).toContain(nidA);
    expect(result.interest!.get("sB")).toContain(nidB);

    // 两者快照 mapId 均为 cave（同世界共享生态）
    expect(result.snapshot.entities.get(nidA)?.mapId).toBe(CAVE_MAP_ID);
    expect(result.snapshot.entities.get(nidB)?.mapId).toBe(CAVE_MAP_ID);
  });

  it("场景4：sA 返回 generated-map 后，无玩家的 cave 继续按规则刷怪（常驻模拟）", async () => {
    const { sim, world, eA } = await setupTwoPlayers();

    const portal = findPortal(world, DEFAULT_MAP_ID, CAVE_MAP_ID);
    expect(portal).toBeDefined();
    crossPortal(world, sim, portal!, eA, CAVE_MAP_ID);

    // cave 里跑 40 tick（约 2 个 1000ms 周期，cave 生态积累但未到 max 上限）
    for (let i = 0; i < 40; i++) sim.tick(TICK_MS);

    // sA 经 cave 的回传传送门回 generated-map
    const backPortal = findPortal(world, CAVE_MAP_ID, DEFAULT_MAP_ID);
    expect(backPortal).toBeDefined();
    const back = crossPortal(world, sim, backPortal!, eA, DEFAULT_MAP_ID);
    expect(back.snapshot.playerMaps.get("sA")).toBe(DEFAULT_MAP_ID);

    // 离开时 cave 里没有任何玩家（sB 一直在 generated-map）
    const before = countMapEntities(back, CAVE_MAP_ID);
    expect(before).toBeGreaterThan(0);

    // 再推 25 tick：空图（含无玩家）常驻运行，cave 生态保持（不消失）
    let result = back;
    for (let i = 0; i < 25; i++) {
      result = sim.tick(TICK_MS);
    }
    const after = countMapEntities(result, CAVE_MAP_ID);
    expect(after).toBeGreaterThanOrEqual(before);
    // sA 依然在 generated-map（回来后再没有被移动）
    expect(result.snapshot.playerMaps.get("sA")).toBe(DEFAULT_MAP_ID);
    expect(result.snapshot.playerMaps.get("sB")).toBe(DEFAULT_MAP_ID);
  });

  it("场景5：存档/读档 roundtrip——恢复 + addPlayer 后各回各图", async () => {
    // server.json 的 saveIntervalMs=60000 超出测试时长——按既定路径把存档间隔
    // 在内存里调小（镜像 slice5 的 resolvedRules 注入模式，不写配置文件），
    // 存档链路（maybeAutosave → fileRepository → loadWorld → initialRecord）全部走真。
    const def = loadGameDefinition({ gameJsonPath: GAME_JSON });
    def.resolvedRules["server"] = {
      ...(def.resolvedRules["server"] as object),
      saveIntervalMs: 200,
    };
    const dir = mkdtempSync(join(tmpdir(), "t17-maps-"));
    const repo = createFileRepository(dir);
    const sim = await createGameSimulation(def, { repository: repo, saveId: SAVE_ID });
    const world = simWorld(sim);
    const nidA = sim.addPlayer("sA").networkId;
    const nidB = sim.addPlayer("sB").networkId;
    const eA = playerEidByNetworkId(world, nidA);
    const eB = playerEidByNetworkId(world, nidB);

    // 分图状态：A 进 cave，B 留 generated-map
    sim.tick(TICK_MS);
    const portal = findPortal(world, DEFAULT_MAP_ID, CAVE_MAP_ID);
    expect(portal).toBeDefined();
    crossPortal(world, sim, portal!, eA, CAVE_MAP_ID);
    const preSave = sim.tick(TICK_MS);
    expect(preSave.snapshot.playerMaps.get("sA")).toBe(CAVE_MAP_ID);
    expect(preSave.snapshot.playerMaps.get("sB")).toBe(DEFAULT_MAP_ID);

    // 累计 300ms > 200ms → 自动存档（fire-and-forget 写盘）
    for (let i = 0; i < 6; i++) sim.tick(TICK_MS);
    let record = null;
    for (let i = 0; i < 100 && record === null; i++) {
      record = await repo.loadWorld(SAVE_ID);
      if (record === null) await new Promise((r) => setTimeout(r, 15));
    }
    expect(record).not.toBeNull();
    // 存档内玩家归属已按 EntityMap 入档（A→cave, B→generated-map）
    const savedByNid = new Map(
      record!.entities.map((e) => [e.networkId, (e.components["EntityMap"] as string) ?? ""]),
    );
    expect(savedByNid.get(nidA)).toBe(CAVE_MAP_ID);
    expect(savedByNid.get(nidB)).toBe(DEFAULT_MAP_ID);
    void eB;

    // 服务端重启：repository 预载恢复（读档通道唯一化）+ addPlayer 复用绑定
    const sim2 = await createGameSimulation(def, { repository: repo, saveId: SAVE_ID });
    expect(sim2.addPlayer("sA").networkId).toBe(nidA);
    expect(sim2.addPlayer("sB").networkId).toBe(nidB);
    const restored = sim2.tick(TICK_MS);
    expect(restored.snapshot.playerMaps.get("sA")).toBe(CAVE_MAP_ID);
    expect(restored.snapshot.playerMaps.get("sB")).toBe(DEFAULT_MAP_ID);
    expect(restored.snapshot.entities.get(nidA)?.mapId).toBe(CAVE_MAP_ID);
    expect(restored.snapshot.entities.get(nidB)?.mapId).toBe(DEFAULT_MAP_ID);
    // 恢复后跨图隔离仍在
    expect(restored.interest).toBeDefined();
    expect(restored.interest!.get("sA")).not.toContain(nidB);
    expect(restored.interest!.get("sB")).not.toContain(nidA);
  });

  it("场景6：长程 tick 基线——无异常、无跨图泄漏", async () => {
    const { sim, world, eA, nidA, nidB } = await setupTwoPlayers();

    const portal = findPortal(world, DEFAULT_MAP_ID, CAVE_MAP_ID);
    expect(portal).toBeDefined();
    crossPortal(world, sim, portal!, eA, CAVE_MAP_ID);

    // 连续 60 tick（3 秒），每帧校验：tick 递增、interest 恒在、跨图零泄漏
    let result = sim.tick(TICK_MS);
    const expectedTicks: number[] = [];
    for (let i = 0; i < 60; i++) {
      result = sim.tick(TICK_MS);
      expectedTicks.push(result.tick);
      expect(result.interest).toBeDefined();
      expect(result.snapshot.playerMaps.get("sA")).toBe(CAVE_MAP_ID);
      expect(result.snapshot.playerMaps.get("sB")).toBe(DEFAULT_MAP_ID);

      // 分区三集合：cave / generated-map / 其它（都不应出现在跨图玩家的 interest）
      const byMap: Record<string, number[]> = {};
      for (const [nid, snap] of result.snapshot.entities) {
        (byMap[snap.mapId] ??= []).push(nid);
      }
      const seenByA = new Set(result.interest!.get("sA"));
      const seenByB = new Set(result.interest!.get("sB"));
      for (const mapId of Object.keys(byMap)) {
        const nids = byMap[mapId];
        if (mapId === CAVE_MAP_ID) {
          // A 在 cave 可看 cave 实体；B（generated-map）绝不能看到
          for (const n of nids) expect(seenByB.has(n)).toBe(false);
        } else if (mapId === DEFAULT_MAP_ID) {
          for (const n of nids) expect(seenByA.has(n)).toBe(false);
        } else {
          // 未知图实体两方都不可见
          for (const n of nids) {
            expect(seenByA.has(n)).toBe(false);
            expect(seenByB.has(n)).toBe(false);
          }
        }
      }
      // own 恒可见
      expect(seenByA.has(nidA)).toBe(true);
      expect(seenByB.has(nidA)).toBe(false);
    }
    // 帧号严格递增（每帧都成功推进，无系统抛错中断）
    for (let i = 1; i < expectedTicks.length; i++) {
      expect(expectedTicks[i]).toBe(expectedTicks[i - 1] + 1);
    }
  });
});
