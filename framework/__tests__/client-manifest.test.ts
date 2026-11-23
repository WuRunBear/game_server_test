/**
 * CC-01 Client Manifest：纯函数层测试。
 *
 * 覆盖：
 * - manifest 必填字段齐全、版本 import 自 protocol.ts、无 undefined 键；
 * - 真实 `game/game.json`：8 图全覆盖、实体原型全覆盖、tile 语义 0..12、
 *   netSync 与配置逐项一致、serverRules 只输出配置实值；
 * - `contentVersion`：同配置稳定、键序无关、表现/规则/netSync/tickRate 变化即变；
 * - 实体表现查询层与 `game/presentation/entities.json` 合并/重复 kind 报错。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapFramework } from "framework/bootstrap";
import { loadGameDefinition } from "framework/bootstrap/loadGameDefinition";
import { buildContentCatalog } from "framework/content/catalog";
import {
  buildClientManifest,
  computeContentVersion,
  stableStringify,
  type ClientManifest,
} from "framework/content/manifest";
import {
  getEntityPresentation,
  listEntityPresentations,
} from "framework/content/presentation";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { PresentationConfig } from "framework/config/schema/PresentationSchema";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "framework/net/protocol";

/** 递归断言对象图中没有 undefined（JSON 序列化会静默丢键，故单独检查）。 */
function expectNoUndefined(value: unknown, path = "manifest"): void {
  expect(value, path).not.toBeUndefined();
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectNoUndefined(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    expectNoUndefined(child, `${path}.${key}`);
  }
}

/** 展平 manifest 顶层段，便于逐段断言。 */
function sectionNames(manifest: ClientManifest): string[] {
  return Object.keys(manifest).sort();
}

let gameDef: LoadedGameDefinition;
let manifest: ClientManifest;

beforeAll(() => {
  bootstrapFramework();
  gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
  manifest = buildClientManifest(gameDef);
});

describe("client manifest: 形状与版本", () => {
  it("必填顶层段齐全且无 undefined", () => {
    expect(sectionNames(manifest)).toEqual(
      [
        "animations",
        "audio",
        "contentVersion",
        "damageTypes",
        "entities",
        "factions",
        "items",
        "maps",
        "netSync",
        "protocolVersion",
        "schemaVersion",
        "serverRules",
        "stationTypes",
        "statusEffects",
        "tickRate",
        "tileSemantics",
        "world",
      ].sort(),
    );
    expectNoUndefined(manifest);
  });

  it("protocolVersion / schemaVersion 与 protocol.ts 一致；contentVersion 为 8 位 hex", () => {
    expect(manifest.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(manifest.contentVersion).toMatch(/^[0-9a-f]{8}$/);
  });

  it("tickRate / world 来自 game.json；未实现段为空数组/空对象", () => {
    expect(manifest.tickRate).toBe(gameDef.tickRate);
    expect(manifest.world).toEqual({
      tileWidth: gameDef.world.tile.width,
      tileHeight: gameDef.world.tile.height,
    });
    // world.storyHeight 当前没有配置来源，不得出现魔法数
    expect("storyHeight" in manifest.world).toBe(false);
    expect(manifest.animations).toEqual({});
    expect(manifest.audio).toEqual({});
    expect(manifest.statusEffects).toEqual([]);
  });

  it("factions / stationTypes / damageTypes 复用 /content catalog 且非空", () => {
    const catalog = buildContentCatalog(gameDef);
    expect(manifest.factions).toEqual(catalog.factions);
    expect(manifest.stationTypes).toEqual(catalog.stationTypes);
    expect(manifest.damageTypes).toEqual(catalog.damageTypes);

    expect(manifest.factions.length).toBeGreaterThan(0);
    expect(manifest.stationTypes.length).toBeGreaterThan(0);
    expect(manifest.damageTypes.length).toBeGreaterThan(0);
    expect(manifest.factions.map((faction) => faction.id)).toContain("village");
    expect(manifest.stationTypes.map((station) => station.id)).toContain(1);
    expect(manifest.damageTypes.map((damage) => damage.id).sort()).toEqual(
      expect.arrayContaining(["pierce", "slash"]),
    );
  });
});

describe("client manifest: 真实 game/ 配置覆盖", () => {
  it("maps 覆盖 resolvedMapConfigs 全部 key（当前 8 图）", () => {
    const expected = gameDef.resolvedMapConfigs.map((config) => config.key);
    expect(manifest.maps.map((entry) => entry.id)).toEqual(expected);
    expect(expected).toHaveLength(8);

    for (const map of manifest.maps) {
      expect(map.displayName, map.id).toBeTruthy();
      expect(Array.isArray(map.connections)).toBe(true);
      expect(map.tileSemantics).toBeTypeOf("object");
    }
  });

  it("tileSemantics 覆盖 0..12（含坡度/悬崖/焦土/季节），跨图覆盖生效", () => {
    const island = manifest.maps.find((map) => map.id === "island")!;
    const islandSemantics = island.tileSemantics!;
    for (let id = 0; id <= 12; id++) {
      expect(islandSemantics[String(id)], `island tile ${id}`).toBeDefined();
    }
    expect(islandSemantics["9"].name).toBe("scorched_ground");
    expect(islandSemantics["10"].name).toBe("snow");
    expect(islandSemantics["11"].name).toBe("wet_ground");
    expect(islandSemantics["12"].name).toBe("dry_grass");

    // 每图覆盖优先：cave 的 1 是墙，不是全局深水
    const cave = manifest.maps.find((map) => map.id === "cave")!;
    expect(cave.tileSemantics!["1"].name).toBe("cave_wall");
    expect(manifest.tileSemantics["1"].name).toBe("deep_ocean");

    // quantize-terrain 图带 levelSemantics
    const highlands = manifest.maps.find((map) => map.id === "highlands")!;
    expect(highlands.levelSemantics).toEqual({ slope: 7, cliff: 8 });
    expect(island.levelSemantics).toBeUndefined();
  });

  it("entities 覆盖全部 archetype kind，字段来自 tags / Size / entities.json", () => {
    const expectedKinds = gameDef.resolvedEntities.map((entity) => entity.kind).sort();
    const actualKinds = manifest.entities.map((entity) => entity.kind);
    expect(actualKinds).toHaveLength(expectedKinds.length);
    expect([...actualKinds].sort()).toEqual(expectedKinds);

    for (const entity of manifest.entities) {
      expect(entity.category, entity.kind).toBeTruthy();
      expect(Array.isArray(entity.tags)).toBe(true);
      expect(entity.anchor).toEqual({ x: 0.5, y: 1 });
      expect(entity.visualId).toBe(entity.kind);
      expect(entity.animationSetId).toBe(entity.kind);
      expect(entity.audioSetId).toBe(entity.kind);
      expect(typeof entity.shadow).toBe("boolean");
      // game/presentation/entities.json 为每个 kind 都填了展示名
      expect(entity.displayName, entity.kind).toBeTruthy();
      // 表现配置的尺寸与 archetype Size（px）保持一致（防止两处漂移）
      expect(getEntityPresentation(entity.kind)?.size, entity.kind).toEqual(entity.size);
    }

    const byKind = new Map(manifest.entities.map((entity) => [entity.kind, entity]));
    expect(byKind.get("tree")).toMatchObject({
      displayName: "树",
      category: "resource",
      size: { w: 16, h: 16 },
      shadow: false,
    });
    expect(byKind.get("wolf")).toMatchObject({
      displayName: "狼",
      category: "enemy",
      shadow: true,
    });
    expect(byKind.get("player")).toMatchObject({
      category: "player",
      size: { w: 8, h: 8 },
      shadow: true,
    });
    expect(byKind.get("villager")!.category).toBe("npc");
    expect(byKind.get("corpse")!.category).toBe("container");
    expect(byKind.get("item")!.category).toBe("item");
    // 组件优先：有 Structure/Placeable 的无 tag 原型归 structure（与运行时 Category.value 一致）
    expect(byKind.get("campfire")!.category).toBe("structure");
    expect(byKind.get("wall")!.category).toBe("structure");
    expect(byKind.get("door")!.category).toBe("structure");
    expect(byKind.get("furniture")!.category).toBe("structure");
    // portal* 无 tags/Structure/Placeable/Projectile → other（运行时同）
    expect(byKind.get("portal")!.category).toBe("other");
    expect(byKind.get("wall")!.tags).toEqual([]);
  });

  it("entities category 与运行时 categoryOf 的优先级一致（组件优先）", () => {
    const earlyTags: Array<[string, string]> = [
      ["Player", "player"],
      ["Enemy", "enemy"],
      ["NPC", "npc"],
    ];
    const lateTags: Array<[string, string]> = [
      ["Resource", "resource"],
      ["Container", "container"],
      ["Item", "item"],
    ];
    const expectedCategory = (tags: string[], components: Record<string, unknown>): string => {
      for (const [tag, category] of earlyTags) if (tags.includes(tag)) return category;
      if (Object.hasOwn(components, "Projectile")) return "projectile";
      if (Object.hasOwn(components, "Structure") || Object.hasOwn(components, "Placeable")) {
        return "structure";
      }
      for (const [tag, category] of lateTags) if (tags.includes(tag)) return category;
      return "other";
    };

    for (const archetype of gameDef.resolvedEntities) {
      const entity = manifest.entities.find((entry) => entry.kind === archetype.kind)!;
      expect(entity.category, archetype.kind).toBe(
        expectedCategory([...(archetype.tags ?? [])], archetype.components),
      );
    }
  });

  it("netSync 与 game.json 逐项一致（tags 缺省为空数组）", () => {
    const expected = (gameDef.netSync?.fields ?? []).map((entry) => ({
      component: entry.component,
      fields: [...entry.fields],
      tags: [...(entry.tags ?? [])],
    }));
    expect(manifest.netSync).toEqual(expected);
    expect(manifest.netSync.length).toBeGreaterThan(20);
    expect(manifest.netSync.find((entry) => entry.component === "Transform")).toEqual({
      component: "Transform",
      fields: ["x", "y", "rot", "scale"],
      tags: [],
    });
  });

  it("serverRules 只输出配置实际值（offlineRetentionTicks 未配置即省略）", () => {
    expect(manifest.serverRules).toEqual({
      viewRadius: 304,
      maxMoveSpeed: 32,
      maxCommandsPerSec: 20,
      placeRange: 64,
      talkRange: 48,
      containerRange: 64,
      stationRange: 64,
    });
    expect("offlineRetentionTicks" in manifest.serverRules).toBe(false);
  });

  it("items 覆盖全部物品 kind，轻量索引含 label / maxStack", () => {
    const expected = gameDef.resolvedItems.map((item) => item.kind).sort();
    expect(manifest.items.map((item) => item.kind)).toEqual(expected);

    const axe = manifest.items.find((item) => item.kind === "axe")!;
    expect(axe.maxStack).toBe(1);
    expect(axe.label.length).toBeGreaterThan(0);
    expect(manifest.items.find((item) => item.kind === "wood")!.maxStack).toBe(50);
  });
});

describe("client manifest: 缺省/降级路径", () => {
  it("无表现配置时 maps 只出 id（其余字段省略），实体按 tags 推导", () => {
    const minimal = {
      id: "fixture",
      tickRate: 10,
      world: { tile: { width: 24, height: 24 } },
      resolvedMapConfigs: [{ key: "map-a", initialAgeTicks: 0, pipeline: [] }],
      resolvedEntities: [
        { kind: "creature-a", tags: ["Enemy"], components: { Size: { w: 30, h: 20 } } },
        { kind: "structure-a", components: { Placeable: {} } },
        { kind: "projectile-a", components: { Projectile: {} } },
        { kind: "thing-b", components: {} },
      ],
      resolvedBehaviors: [],
      resolvedRules: {},
      resolvedItems: [],
      resolvedDialogues: [],
      resolvedQuests: [],
      resolvedEntityRules: [],
    } as unknown as LoadedGameDefinition;

    const built = buildClientManifest(minimal);
    expect(built.maps).toEqual([{ id: "map-a" }]);
    expect(built.tileSemantics).toEqual({});
    expect(built.serverRules).toEqual({});
    expect(built.netSync).toEqual([]);
    expect(built.items).toEqual([]);

    const creature = built.entities.find((entity) => entity.kind === "creature-a")!;
    expect(creature).toMatchObject({
      category: "enemy",
      tags: ["Enemy"],
      size: { w: 30, h: 20 },
      anchor: { x: 0.5, y: 1 },
      visualId: "creature-a",
      animationSetId: "creature-a",
      audioSetId: "creature-a",
      shadow: true,
    });
    expect(creature.displayName).toBeUndefined();
    expect("displayName" in creature).toBe(false);

    const thing = built.entities.find((entity) => entity.kind === "thing-b")!;
    expect(thing.category).toBe("other");
    expect(thing.shadow).toBe(false);
    expect(thing).not.toHaveProperty("size");

    // 组件优先（无 tags 也归 structure / projectile）
    expect(built.entities.find((entity) => entity.kind === "structure-a")!.category).toBe("structure");
    expect(built.entities.find((entity) => entity.kind === "projectile-a")!.category).toBe("projectile");
  });
});

describe("client manifest: contentVersion", () => {
  it("相同配置重复构建稳定，且与键序无关", () => {
    const again = buildClientManifest(gameDef);
    expect(again.contentVersion).toBe(manifest.contentVersion);
    expect(JSON.stringify(again)).toBe(JSON.stringify(manifest));

    const a = computeContentVersion({ tickRate: 20, netSync: [{ component: "A", fields: ["x"], tags: [] }] });
    const b = computeContentVersion({ netSync: [{ tags: [], fields: ["x"], component: "A" }], tickRate: 20 });
    expect(a).toBe(b);
    expect(stableStringify({ b: 2, a: { d: 4, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 4 }, b: 2 }));
  });

  it("跨进程稳定：固定输入得到固定指纹（规范 JSON + FNV-1a 契约）", () => {
    const fingerprint = computeContentVersion({
      tickRate: 20,
      world: { tileWidth: 16, tileHeight: 16 },
      netSync: [{ component: "Transform", fields: ["x", "y"], tags: [] }],
      items: [{ kind: "a", maxStack: 1 }],
    });
    expect(fingerprint).toBe("014f0200");
  });

  it("表现输入（地图名 / tile 语义 / 实体展示名）变化即变", () => {
    const base = structuredClone(gameDef.resolvedPresentation!) as PresentationConfig;

    const renamedMap = structuredClone(base);
    renamedMap.maps["island"].displayName = "Changed Map";
    expect(buildClientManifest(gameDef, { presentation: renamedMap }).contentVersion).not.toBe(
      manifest.contentVersion,
    );

    const renamedTile = structuredClone(base);
    renamedTile.tileSemantics["0"].name = "void-changed";
    expect(buildClientManifest(gameDef, { presentation: renamedTile }).contentVersion).not.toBe(
      manifest.contentVersion,
    );

    const renamedEntity = structuredClone(base);
    renamedEntity.entities!["tree"].displayName = "Changed Tree";
    expect(buildClientManifest(gameDef, { presentation: renamedEntity }).contentVersion).not.toBe(
      manifest.contentVersion,
    );
  });

  it("netSync / tickRate / world / serverRules 变化即变", () => {
    const base = {
      tickRate: 20,
      world: { tileWidth: 16, tileHeight: 16 },
      netSync: [{ component: "Transform", fields: ["x", "y"], tags: [] }],
      serverRules: { viewRadius: 304 },
    };
    const version = computeContentVersion(base);

    expect(
      computeContentVersion({ ...base, netSync: [{ component: "Transform", fields: ["x"], tags: [] }] }),
    ).not.toBe(version);
    expect(computeContentVersion({ ...base, tickRate: 30 })).not.toBe(version);
    expect(computeContentVersion({ ...base, world: { tileWidth: 32, tileHeight: 32 } })).not.toBe(version);
    expect(computeContentVersion({ ...base, serverRules: { viewRadius: 320 } })).not.toBe(version);
    expect(computeContentVersion({ ...base, entityKinds: ["a"] })).not.toBe(version);
    expect(
      computeContentVersion({ ...base, entityArchetypes: [{ kind: "a", tags: [], size: null }] }),
    ).not.toBe(version);
    expect(computeContentVersion({ ...base, mapIds: ["a"] })).not.toBe(version);
  });

  it("内容段（物品/配方/任务/成就/相位/技能/势力/站点/伤害类型）变化即变", () => {
    const base = {
      items: [{ kind: "a", maxStack: 1 }],
      recipes: [{ id: "r", inputs: [{ kind: "a", count: 1 }] }],
      quests: [{ id: "q" }],
      achievements: [{ id: "ach" }],
      phases: [{ id: "p" }],
      skills: { s: { curve: [1] } },
      factions: [{ id: "f" }],
      stationTypes: [{ id: 1 }],
      damageTypes: [{ id: "pierce" }],
    };
    const version = computeContentVersion(base);
    expect(computeContentVersion({ ...base, items: [{ kind: "a", maxStack: 2 }] })).not.toBe(version);
    expect(computeContentVersion({ ...base, recipes: [{ id: "r", inputs: [{ kind: "a", count: 2 }] }] })).not.toBe(version);
    expect(computeContentVersion({ ...base, quests: [{ id: "q2" }] })).not.toBe(version);
    expect(computeContentVersion({ ...base, achievements: [{ id: "ach2" }] })).not.toBe(version);
    expect(computeContentVersion({ ...base, phases: [{ id: "p2" }] })).not.toBe(version);
    expect(computeContentVersion({ ...base, skills: { s: { curve: [2] } } })).not.toBe(version);
    expect(computeContentVersion({ ...base, factions: [{ id: "f2" }] })).not.toBe(version);
    expect(computeContentVersion({ ...base, stationTypes: [{ id: 2 }] })).not.toBe(version);
    expect(computeContentVersion({ ...base, damageTypes: [{ id: "slash" }] })).not.toBe(version);
  });
});

describe("client manifest: 实体表现查询与配置合并", () => {
  it("getEntityPresentation / listEntityPresentations 反映当前游戏配置", () => {
    expect(getEntityPresentation("tree")?.displayName).toBe("树");
    expect(getEntityPresentation("no-such-kind")).toBeUndefined();
    expect(listEntityPresentations()["tree"]?.category).toBe("resource");
  });

  describe("loadGameDefinition 合并 presentation/entities.json", () => {
    const dirs: string[] = [];

    function makeGameDir(files: { maps?: unknown; entities?: unknown }): string {
      const dir = mkdtempSync(join(tmpdir(), "manifest-fixture-"));
      dirs.push(dir);
      mkdirSync(join(dir, "maps"), { recursive: true });
      mkdirSync(join(dir, "presentation"), { recursive: true });
      writeFileSync(
        join(dir, "game.json"),
        JSON.stringify({ id: "manifest-fixture", tickRate: 20, map: { registry: "./maps/registry.json" } }),
      );
      writeFileSync(join(dir, "maps", "registry.json"), JSON.stringify({ maps: {} }));
      if (files.maps !== undefined) {
        writeFileSync(join(dir, "presentation", "maps.json"), JSON.stringify(files.maps));
      }
      if (files.entities !== undefined) {
        writeFileSync(join(dir, "presentation", "entities.json"), JSON.stringify(files.entities));
      }
      return dir;
    }

    afterAll(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it("maps.json 与 entities.json 按约定合并（不同 kind）", () => {
      const dir = makeGameDir({
        maps: { maps: {}, entities: { alpha: { category: "resource" } } },
        entities: { entities: { beta: { category: "enemy", displayName: "Beta" } } },
      });
      const loaded = loadGameDefinition({ gameJsonPath: join(dir, "game.json") });
      expect(Object.keys(loaded.resolvedPresentation!.entities ?? {}).sort()).toEqual(["alpha", "beta"]);
      expect(getEntityPresentation("beta")?.displayName).toBe("Beta");
      // anchor 在 schema 层补缺省值
      expect(getEntityPresentation("alpha")?.anchor).toEqual({ x: 0.5, y: 1 });
    });

    it("跨文件重复 kind 即加载报错", () => {
      const dir = makeGameDir({
        maps: { maps: {}, entities: { dup: {} } },
        entities: { entities: { dup: {} } },
      });
      expect(() => loadGameDefinition({ gameJsonPath: join(dir, "game.json") })).toThrow(
        /presentation: duplicate entity presentation "dup"/,
      );
    });
  });
});
