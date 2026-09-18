/**
 * 新档随机种子入口（WorldRecord.mapSeeds，map-system 设计 §5.4 修复项 4）。
 *
 * 覆盖（boot.ts 两条开机分支 + 弱表读路径）：
 * - 无档 + 配置缺省 seed → 开机随机解析并随首存快照固化（record.mapSeeds）；
 * - 无档 + registry 固定 seed → 固定值原样固化（快照 seed = 配置 seed）；
 * - 读档分支：seed 取快照固化值（回填几何不重生成），弱表与快照一致；
 * - 旧格式存档（无 mapSeeds 字段）→ 回退配置 seed；
 * - 演化流同源性：同一份 record 两次读档开机 → 同 seed 同选点流（同跨度
 *   evolve 产出实体逐格一致）；换 seed → 选点流不同。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { query } from "bitecs";
import { bootstrapFramework, createDefaultGameDefinition, createGameInstance } from "framework/index";
import { getMapSeeds } from "map/runtime/mapSeeds";
import { evolve } from "map/evolution/engine";
import { createMapEvolveDeps } from "map/runtime/evolveDeps";
import { serializeGeometry, type SerializedMapGeometry } from "map/geometry/snapshot";
import { Kind } from "framework/components/kind";
import { Transform } from "framework/components/transform";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { MapConfig } from "framework/config/schema/MapRegistrySchema";
import type { WorldRecord } from "framework/repository";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  bootstrapFramework();
});

const MAP = "seed-map";
const KIND = "seed-ent";
const INITIAL_AGE = 1000;

/** 8×8 全可走单区域图配置；seed 缺省时**不声明**该键（新档随机入口的触发形态）。 */
function mapConfig(seed?: number): MapConfig {
  const config: MapConfig = {
    key: MAP,
    initialAgeTicks: INITIAL_AGE,
    pipeline: [
      {
        generator: "noise-terrain",
        params: {
          width: 8,
          height: 8,
          tileWidth: 16,
          tileHeight: 16,
          bandLevel: 1,
          groundPalette: { "1": 1 },
          nonWalkableSemantics: [],
        },
      },
      { generator: "climate-regions", params: { names: ["alpha"], style: "noise" } },
    ],
  };
  if (seed !== undefined) config.seed = seed;
  return config;
}

function buildDef(seed?: number): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.resolvedEntities = [{ kind: KIND, components: {} }];
  def.resolvedMapConfigs = [mapConfig(seed)];
  def.resolvedEntityRules = [
    { map: MAP, region: "alpha", kind: KIND, max: 3, every: 10, mode: "density" },
  ];
  def.resolvedStaticEntityRules = def.resolvedEntityRules;
  return def;
}

function snapshotMapsOf(world: GameWorld): Record<string, SerializedMapGeometry> {
  return Object.fromEntries(
    Object.entries(world.maps).map(([key, geometry]) => [key, serializeGeometry(geometry)]),
  );
}

function makeRecord(
  maps: Record<string, SerializedMapGeometry>,
  tick: number,
  mapSeeds?: Record<string, number>,
): WorldRecord {
  return {
    id: "seed-test",
    savedAt: Date.now(),
    tick,
    nextNetworkId: 1,
    maps,
    ...(mapSeeds ? { mapSeeds } : {}),
    entities: [],
  };
}

/** 某 kind 实体的 tile 坐标（排序后比较——选点流一致 ⇔ 坐标逐一一致）。 */
function tilePositionsOf(world: GameWorld, kind: string): string[] {
  const geometry = world.maps[MAP]!;
  const out: string[] = [];
  for (const eid of query(world, [Transform])) {
    if (Kind[eid] !== kind) continue;
    const tx = Math.floor(Transform.x[eid] / geometry.grid.tileWidth);
    const ty = Math.floor(Transform.y[eid] / geometry.grid.tileHeight);
    out.push(`${tx},${ty}`);
  }
  return out.sort();
}

describe("新档随机种子入口（mapSeeds）", () => {
  it("无档 + 配置缺省 seed：开机随机解析并随首存快照固化（record.mapSeeds = 弱表）", () => {
    let captured: WorldRecord | undefined;
    const instance = createGameInstance(buildDef(undefined), {
      loadRecord: () => null,
      saveRecord: (record) => {
        captured = record;
      },
    });

    expect(captured).toBeDefined();
    const seed = captured!.mapSeeds?.[MAP];
    expect(typeof seed).toBe("number");
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed!).toBeLessThanOrEqual(0xffffffff);
    // 弱表与首存快照同源（serializeWorld 从弱表取值）
    expect(getMapSeeds(instance.world)).toEqual(captured!.mapSeeds);
  });

  it("无档 + registry 固定 seed：固定值原样固化（record.absent 时不随机顶替）", () => {
    let captured: WorldRecord | undefined;
    createGameInstance(buildDef(42), {
      loadRecord: () => null,
      saveRecord: (record) => {
        captured = record;
      },
    });
    expect(captured!.mapSeeds?.[MAP]).toBe(42);
  });

  it("读档分支：seed 取快照固化值（弱表 = record.mapSeeds），几何按快照回填", () => {
    // 先做一次开机拿到几何快照（作为读档输入），再以手工 mapSeeds 读档
    let snapshotMaps: Record<string, SerializedMapGeometry> | undefined;
    createGameInstance(buildDef(1), {
      loadRecord: () => null,
      saveRecord: (record) => {
        snapshotMaps = record.maps;
      },
    });
    const record = makeRecord(snapshotMaps!, INITIAL_AGE, { [MAP]: 777 });

    const instance = createGameInstance(buildDef(undefined), {
      loadRecord: () => record,
      saveRecord: () => {},
    });
    expect(getMapSeeds(instance.world)?.[MAP]).toBe(777);
  });

  it("旧格式存档（无 mapSeeds 字段）：回退配置 seed", () => {
    let snapshotMaps: Record<string, SerializedMapGeometry> | undefined;
    createGameInstance(buildDef(1), {
      loadRecord: () => null,
      saveRecord: (record) => {
        snapshotMaps = record.maps;
      },
    });
    const legacy = makeRecord(snapshotMaps!, INITIAL_AGE); // 无 mapSeeds

    const instance = createGameInstance(buildDef(42), {
      loadRecord: () => legacy,
      saveRecord: () => {},
    });
    expect(getMapSeeds(instance.world)?.[MAP]).toBe(42);
  });

  it("演化流同源：同一 record 两次读档开机 → 同 seed 同选点流（逐格一致）；换 seed 则不同", () => {
    let snapshotMaps: Record<string, SerializedMapGeometry> | undefined;
    createGameInstance(buildDef(1), {
      loadRecord: () => null,
      saveRecord: (record) => {
        snapshotMaps = record.maps;
      },
    });

    // 存档 tick=999（槽 1000 ∈ (999, 1000]），实体清空 → 单槽 evolve 补足 max=3
    const recordA = makeRecord(snapshotMaps!, 999, { [MAP]: 777 });
    const recordB = makeRecord(snapshotMaps!, 999, { [MAP]: 42 });

    const placements = (record: WorldRecord): string[] => {
      const instance = createGameInstance(buildDef(undefined), {
        loadRecord: () => record,
        saveRecord: () => {},
      });
      const world = instance.world;
      const geometry = world.maps[MAP]!;
      evolve(
        world,
        geometry,
        world.gameDef.resolvedEntityRules,
        record.tick,
        record.tick + 1,
        createMapEvolveDeps(world, geometry, getMapSeeds(world)![MAP]!),
      );
      expect(tilePositionsOf(world, KIND)).toHaveLength(3);
      return tilePositionsOf(world, KIND);
    };

    // 同一 record 两次开机：seed 同源 → 选点流一致
    expect(placements(recordA)).toEqual(placements(recordA));
    // 换 seed：选点流不同（证明快照 seed 真实喂入演化流）
    expect(placements(recordB)).not.toEqual(placements(recordA));
  });
});
