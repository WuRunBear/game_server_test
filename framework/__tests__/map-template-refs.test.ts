/**
 * 命名模板组（templateRef）测试——加载器级解析、引擎零改动
 * （ecosystem-map 设计 §5.3「房屋模板 = 可复用的 template 条目组」+ §6 切片②
 * 「同一份条目组跨规则复用」）。
 *
 * 覆盖：
 * - schema（EntityRulesDocumentSchema）：可选 templates 字典（组名/条目组
 *   非空）、template 与 templateRef 恰好声明其一（双声明/均缺省 fail-fast）；
 * - 解析等价：templateRef 规则经 loader 解析后与 inline 等价规则深相等
 *   （无 templateRef 残留，loader 下游产物形状不变）；
 * - fail-fast：未知组名 → 抛错点名 ref 与规则身份（map|region|kind|mode）；
 * - 校验顺序：解析先于 validateIntegrity——命名组条目的未知 kind 自动入查；
 * - boot 集成：解析产物照常驱动初始演化（引擎零改动）；两条 templateRef
 *   规则身份相同（map|region|kind|mode）→ 开机照常抛「重复规则身份」
 *   （ref 共享不影响身份语义，boot 去重保持）。
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "bitecs";
import {
  bootstrapFramework,
  loadGameDefinition,
  createGameInstance,
} from "framework/index";
import { EntityRulesDocumentSchema } from "map/evolution/schema";
import { Kind } from "framework/components/kind";
import { Transform } from "framework/components/transform";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  bootstrapFramework();
});

const MAP = "m1";
const KIND_A = "kind_a";
const KIND_B = "kind_b";

// ---------------------------------------------------------------------------
// schema 层：entity-rules.json 文档形态
// ---------------------------------------------------------------------------

const HOUSE_GROUP = [
  { kind: KIND_A, dx: 0, dy: 0 },
  { kind: KIND_B, dx: 1, dy: 0 },
];

describe("entity-rules 文档 schema（EntityRulesDocumentSchema）", () => {
  const docWith = (templates: unknown, rules: unknown[]) => ({ templates, rules });

  it("POSITIVE：可选 templates 段；无 templates 的纯 inline 文档向后兼容", () => {
    expect(EntityRulesDocumentSchema.safeParse({ rules: [] }).success).toBe(true);
    expect(
      EntityRulesDocumentSchema.safeParse(docWith({ house: HOUSE_GROUP }, [
        {
          mode: "template",
          map: MAP,
          region: "alpha",
          kind: KIND_A,
          max: 1,
          every: 10,
          templateRef: "house",
        },
      ])).success,
    ).toBe(true);
  });

  it("NEGATIVE：空条目组 / 空组名 / 空 templateRef → 拒绝", () => {
    expect(EntityRulesDocumentSchema.safeParse(docWith({ house: [] }, [])).success).toBe(false);
    expect(EntityRulesDocumentSchema.safeParse(docWith({ "": HOUSE_GROUP }, [])).success).toBe(false);
    expect(
      EntityRulesDocumentSchema.safeParse(docWith({ house: HOUSE_GROUP }, [
        { mode: "template", map: MAP, region: "alpha", kind: KIND_A, max: 1, every: 10, templateRef: "" },
      ])).success,
    ).toBe(false);
  });

  it("NEGATIVE：template 与 templateRef 双声明 / 均缺省 → fail-fast 点名规则 map/region/kind", () => {
    const both = docWith({ house: HOUSE_GROUP }, [
      {
        mode: "template",
        map: MAP,
        region: "alpha",
        kind: KIND_A,
        max: 1,
        every: 10,
        template: HOUSE_GROUP,
        templateRef: "house",
      },
    ]);
    const result = EntityRulesDocumentSchema.safeParse(both);
    expect(result.success).toBe(false);
    if (!result.success) {
      // ZodError.message 是 issue 的 JSON 序列化（引号被转义），断言走原始 issue 消息
      expect(result.error.issues.map((i) => i.message).join("\n")).toMatch(/exactly one/);
      expect(result.error.issues.map((i) => i.message).join("\n")).toMatch(
        new RegExp(`map "${MAP}" region "alpha" kind "${KIND_A}"`),
      );
    }

    const neither = docWith(undefined, [
      { mode: "template", map: MAP, region: "alpha", kind: KIND_A, max: 1, every: 10 },
    ]);
    const result2 = EntityRulesDocumentSchema.safeParse(neither);
    expect(result2.success).toBe(false);
    if (!result2.success) {
      expect(result2.error.issues.map((i) => i.message).join("\n")).toMatch(/exactly one/);
    }
  });
});

// ---------------------------------------------------------------------------
// loader 层：解析等价与 fail-fast（临时 game 目录驱动真实加载链路）
// ---------------------------------------------------------------------------

const GAME_JSON = {
  id: "template-refs-fixture",
  tickRate: 20,
  map: { registry: "./maps/registry.json", entityRules: "./maps/entity-rules.json" },
  entities: "./entities/*.json",
  systems: [],
};

/** 8×8 全可走单区域图（noise-terrain + climate-regions alpha），load 与 boot 共用。 */
const REGISTRY_JSON = {
  maps: {
    [MAP]: {
      kind: "pipeline",
      seed: 42,
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
    },
  },
};

/** 在临时目录组装最小 game 配置（原型 kind_a/kind_b + 单图 + 给定规则文档）。 */
function writeGameDir(rulesDoc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "template-refs-"));
  mkdirSync(join(dir, "entities"), { recursive: true });
  mkdirSync(join(dir, "maps"), { recursive: true });
  writeFileSync(join(dir, "game.json"), JSON.stringify(GAME_JSON));
  writeFileSync(join(dir, "entities", "a.json"), JSON.stringify({ kind: KIND_A, components: {} }));
  writeFileSync(join(dir, "entities", "b.json"), JSON.stringify({ kind: KIND_B, components: {} }));
  writeFileSync(join(dir, "maps", "registry.json"), JSON.stringify(REGISTRY_JSON));
  writeFileSync(join(dir, "maps", "entity-rules.json"), JSON.stringify(rulesDoc));
  return dir;
}

function loadFrom(dir: string): LoadedGameDefinition {
  return loadGameDefinition({ gameJsonPath: join(dir, "game.json") });
}

/** 规则文档：一份 inline 形态 + 一份等价 templateRef 形态（同一条目组）。 */
const INLINE_DOC = {
  rules: [
    { mode: "density", map: MAP, region: "alpha", kind: KIND_A, max: 3, every: 10 },
    { mode: "template", map: MAP, region: "alpha", kind: KIND_A, max: 2, every: 10, template: HOUSE_GROUP },
  ],
};
const REF_DOC = {
  templates: { house: HOUSE_GROUP },
  rules: [
    { mode: "density", map: MAP, region: "alpha", kind: KIND_A, max: 3, every: 10 },
    { mode: "template", map: MAP, region: "alpha", kind: KIND_A, max: 2, every: 10, templateRef: "house" },
  ],
};

describe("loadEntityRules：templateRef 解析", () => {
  const dirs: string[] = [];
  const makeDir = (rulesDoc: unknown): string => {
    const dir = writeGameDir(rulesDoc);
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("解析等价：templateRef 规则展开后与 inline 等价规则深相等，无 templateRef 残留", () => {
    const fromRef = loadFrom(makeDir(REF_DOC));
    const fromInline = loadFrom(makeDir(INLINE_DOC));

    expect(fromRef.resolvedEntityRules).toEqual(fromInline.resolvedEntityRules);
    expect(fromRef.resolvedStaticEntityRules).toEqual(fromInline.resolvedStaticEntityRules);
    // 活列表/静态列表均无 ref 字段残留（下游只认 inline 形态）
    for (const rule of fromRef.resolvedEntityRules) {
      expect("templateRef" in rule).toBe(false);
    }
  });

  it("NEGATIVE：未知组名 → 抛错点名 ref 与规则身份（map|region|kind|mode）", () => {
    const dir = makeDir({
      templates: { house: HOUSE_GROUP },
      rules: [
        { mode: "template", map: MAP, region: "alpha", kind: KIND_A, max: 1, every: 10, templateRef: "ghost" },
      ],
    });
    expect(() => loadFrom(dir)).toThrow(
      new RegExp(`\`${MAP}\\|alpha\\|${KIND_A}\\|template\`.*templateRef "ghost"`),
    );
  });

  it("NEGATIVE：template 与 templateRef 双声明 / 均缺省 → 加载期抛错", () => {
    const both = makeDir({
      templates: { house: HOUSE_GROUP },
      rules: [
        {
          mode: "template",
          map: MAP,
          region: "alpha",
          kind: KIND_A,
          max: 1,
          every: 10,
          template: HOUSE_GROUP,
          templateRef: "house",
        },
      ],
    });
    expect(() => loadFrom(both)).toThrow(/exactly one/);

    const neither = makeDir({
      rules: [{ mode: "template", map: MAP, region: "alpha", kind: KIND_A, max: 1, every: 10 }],
    });
    expect(() => loadFrom(neither)).toThrow(/exactly one/);
  });

  it("校验顺序：解析先于 validateIntegrity——命名组条目的未知 kind 自动入查", () => {
    const dir = makeDir({
      templates: { house: [{ kind: "ghost_kind", dx: 1, dy: 0 }] },
      rules: [
        { mode: "template", map: MAP, region: "alpha", kind: KIND_A, max: 1, every: 10, templateRef: "house" },
      ],
    });
    expect(() => loadFrom(dir)).toThrow(/ghost_kind/);
  });
});

// ---------------------------------------------------------------------------
// boot 集成：解析产物驱动初始演化（引擎零改动）+ boot 去重保持
// ---------------------------------------------------------------------------

function countKind(world: GameWorld, kind: string): number {
  let n = 0;
  for (const eid of query(world, [Transform])) {
    if (Kind[eid] === kind) n += 1;
  }
  return n;
}

describe("boot 集成（createGameInstance）", () => {
  const dirs: string[] = [];
  const makeDir = (rulesDoc: unknown): string => {
    const dir = writeGameDir(rulesDoc);
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("解析产物照常驱动初始演化：templateRef 规则成组创建（引擎零改动）", () => {
    // 仅 template 规则（max 按锚 kind 实体数计——同 kind 的 density 规则会
    // 占用锚计数，故 boot 正例用独立文档，max=1 → 恰好 1 组）
    const def = loadFrom(makeDir({
      templates: { house: HOUSE_GROUP },
      rules: [
        { mode: "template", map: MAP, region: "alpha", kind: KIND_A, max: 1, every: 10, templateRef: "house" },
      ],
    }));
    const { world } = createGameInstance(def);

    // 1 组 = 锚 kind_a + 伴生 kind_b，成组原子创建
    expect(countKind(world, KIND_A)).toBe(1);
    expect(countKind(world, KIND_B)).toBe(1);
    expect(world.maps[MAP]).toBeDefined();
  });

  it("boot 去重保持：两条 templateRef 规则身份相同（map|region|kind|mode）→ 开机抛重复规则身份", () => {
    const def = loadFrom(makeDir({
      templates: { house: HOUSE_GROUP },
      rules: [
        { mode: "template", map: MAP, region: "alpha", kind: KIND_A, max: 1, every: 10, templateRef: "house" },
        { mode: "template", map: MAP, region: "alpha", kind: KIND_A, max: 2, every: 10, templateRef: "house" },
      ],
    }));
    expect(() => createGameInstance(def)).toThrow(
      new RegExp(`重复规则身份 \`${MAP}\\|alpha\\|${KIND_A}\\|template\``),
    );
  });
});
