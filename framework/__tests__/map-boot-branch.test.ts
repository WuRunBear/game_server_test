/**
 * 开机逐图分支与开机级校验（framework/map/runtime/boot.ts）。
 *
 * 覆盖：
 * - 配置新增图分支：record 存在但快照缺某配置图 key → 该图走生成+校验+初始
 *   演化，同时快照含有的图按快照回填（以篡改快照证明「回填而非重算」）；
 *   快照中配置已删的 key 丢弃不加载（不进 maps/activeMaps）；
 * - I1/U5 开机拒绝非法配置（配置项点名）：未注册积木、exact 落点不可走、
 *   规则引用未知 kind、规则引用未知 region——启动即失败，不静默带病运行。
 *
 * 用 createGameInstance + 注入 BootDeps 直驱 boot.ts 的分支本身
 * （实体/tick 恢复与离线补差归 restoreWorld/GameSimulation，不在本文件断言面）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  getRegistries,
} from "framework/index";
import { buildMapGeometry } from "map/generate/pipeline";
import { serializeGeometry, type SerializedMapGeometry } from "map/geometry/snapshot";
import { Kind } from "framework/components/kind";
import { Transform } from "framework/components/transform";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { WorldRecord } from "framework/repository";
import type { GameWorld } from "framework/world";
import type { MapConfig } from "framework/config/schema/MapRegistrySchema";

beforeAll(() => {
  bootstrapFramework();
});

const MAP_A = "branch-a";
const MAP_B = "branch-b";
const KIND_A = "branch-ent-a";
const KIND_B = "branch-ent-b";

/** 8×8 全可走单区域图配置（seed 区分两图）。 */
function mapConfig(key: string, seed: number): MapConfig {
  return {
    key,
    seed,
    initialAgeTicks: 1000,
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
}

/** 双图定义：mapA/mapB 各一条 density 规则（kind 不同，便于分别计数）。 */
function buildTwoMapDef(): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.resolvedEntities = [
    { kind: KIND_A, components: {} },
    { kind: KIND_B, components: {} },
  ];
  def.resolvedMapConfigs = [mapConfig(MAP_A, 42), mapConfig(MAP_B, 43)];
  def.resolvedEntityRules = [
    { map: MAP_A, region: "alpha", kind: KIND_A, max: 2, every: 10, mode: "density" },
    { map: MAP_B, region: "alpha", kind: KIND_B, max: 2, every: 10, mode: "density" },
  ];
  return def;
}

function countKind(world: GameWorld, kind: string): number {
  let n = 0;
  for (const eid of query(world, [Transform])) {
    if (Kind[eid] === kind) n += 1;
  }
  return n;
}

describe("开机逐图分支（boot.ts per-map branch）", () => {
  it("配置新增图：快照缺 key 的图生成+初始演化，快照含 key 的图按快照回填（篡改证明），快照多余 key 丢弃", () => {
    // 第一次开机（无档）产出完整快照
    const def = buildTwoMapDef();
    const boot1 = createGameInstance(def);
    const snapshotMaps: Record<string, SerializedMapGeometry> = Object.fromEntries(
      Object.entries(boot1.world.maps).map(([key, geometry]) => [key, serializeGeometry(geometry)]),
    );
    const full: WorldRecord = {
      id: "branch",
      savedAt: Date.now(),
      tick: boot1.world.time.tick,
      nextNetworkId: boot1.world.nextNetworkId,
      timeOfDay: { ...boot1.world.time.timeOfDay },
      maps: snapshotMaps,
      entities: [],
    };
    expect(Object.keys(snapshotMaps).sort()).toEqual([MAP_A, MAP_B]);

    // 模拟「旧配置存档」：快照只含 mapA（且被篡改一格 walkable 以证明回填来源）、
    // 另含一个配置已删的 mapC
    const mutatedSnapshot = {
      ...snapshotMaps[MAP_A]!,
      walkable: snapshotMaps[MAP_A]!.walkable.map((v, i) => (i === 0 ? (v === 1 ? 0 : 1) : v)),
    };
    const staleKey = "branch-retired";
    const reduced: WorldRecord = {
      ...full,
      maps: {
        [MAP_A]: mutatedSnapshot,
        [staleKey]: snapshotMaps[MAP_B]!,
      },
    };

    const boot2 = createGameInstance(def, { loadRecord: () => reduced, saveRecord: () => {} });
    const world = boot2.world;

    // 快照回填：mapA 与篡改后的快照逐字节一致（重算会同 seed 复原，篡改值必丢）
    expect(serializeGeometry(world.maps[MAP_A]!)).toEqual(mutatedSnapshot);
    expect(world.maps[MAP_A]!.walkable[0]).toBe(mutatedSnapshot.walkable[0]);

    // 配置新增图：mapB 生成且与同配置现算几何一致，并完成初始演化（规则实体就位）
    const expectedB = buildMapGeometry(mapConfig(MAP_B, 43), getRegistries().mapGeneratorRegistry);
    expect(serializeGeometry(world.maps[MAP_B]!)).toEqual(serializeGeometry(expectedB));
    expect(countKind(world, KIND_B)).toBe(2);
    // 回填图不执行初始演化：mapA 无规则实体（实体恢复归 restoreWorld，不在 boot 分支）
    expect(countKind(world, KIND_A)).toBe(0);

    // 常驻激活：全部配置图（含新增图）激活；快照多余 key 丢弃
    expect(world.activeMaps).toEqual(new Set([MAP_A, MAP_B]));
    expect(world.maps[staleKey]).toBeUndefined();
  });
});

describe("I1/U5 开机拒绝非法配置（配置项点名）", () => {
  it("U5/I1：管道引用未注册积木 → 启动抛错点名图 key 与积木名", () => {
    const def = createDefaultGameDefinition();
    def.resolvedMapConfigs = [
      { ...mapConfig(MAP_A, 42), pipeline: [{ generator: "no-such-block", params: {} }] },
    ];
    expect(() => createGameInstance(def)).toThrow(/branch-a.*no-such-block/);
  });

  it("U5/I1：exact 规则落点不可走 → 启动抛错点名 kind、图 key 与落点坐标", () => {
    const def = createDefaultGameDefinition();
    def.resolvedEntities = [{ kind: KIND_A, components: {} }];
    // bandLevel=1 + 单语义 + 全部不可走 → 任意 exact 落点必 blocked
    def.resolvedMapConfigs = [
      {
        ...mapConfig(MAP_A, 42),
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
              nonWalkableSemantics: [1],
            },
          },
          { generator: "climate-regions", params: { names: ["alpha"], style: "noise" } },
        ],
      },
    ];
    def.resolvedEntityRules = [
      { map: MAP_A, region: "alpha", kind: KIND_A, max: 1, every: 10, mode: "exact", at: { x: 2, y: 2 } },
    ];
    expect(() => createGameInstance(def)).toThrow(/exact rule.*branch-ent-a.*branch-a.*\(2, 2\)/);
  });

  it("U5/I1：规则引用未知 kind → 启动抛错点名 kind（初始演化 spawn 链先拦，boot 校验兜底同判）", () => {
    const def = createDefaultGameDefinition();
    def.resolvedMapConfigs = [mapConfig(MAP_A, 42)];
    def.resolvedEntityRules = [
      { map: MAP_A, region: "alpha", kind: "ghost-kind", max: 1, every: 10, mode: "density" },
    ];
    // 初始演化经 spawn 链生成时 archetypeRegistry 先抛（消息含 kind 名）；
    // boot 收尾的 validateRuleReferences 对零产出路径兜底同判（unknown entity kind）。
    expect(() => createGameInstance(def)).toThrow(/ghost-kind/);
  });

  it("U5/I1：规则引用未知 region → 启动抛错点名 region 与图 key", () => {
    const def = createDefaultGameDefinition();
    def.resolvedEntities = [{ kind: KIND_A, components: {} }];
    def.resolvedMapConfigs = [mapConfig(MAP_A, 42)];
    def.resolvedEntityRules = [
      { map: MAP_A, region: "nowhere", kind: KIND_A, max: 1, every: 10, mode: "density" },
    ];
    expect(() => createGameInstance(def)).toThrow(/unknown region "nowhere" on map "branch-a"/);
  });
});
