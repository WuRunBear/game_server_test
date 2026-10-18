/**
 * aux 槽位池测试（framework/__tests__/map-generate-aux.test.ts）。
 *
 * 覆盖方案 A（GeometryDraft.aux 暂存池）验收：
 * - 生命周期：积木内 setAux 写入 → 冻结后的 MapGeometry 无 aux
 *   （类型层无该字段 + 运行时无泄漏）；
 * - 传递：aux 在管道积木间上游写、下游读；
 * - branded 槽位：同槽位常量读写往返；跨 T 槽位赋值/传值是编译错误
 *   （@ts-expect-error 断言，由 pnpm build 的 tsc 全量编译兜底验证——
 *   若品牌失效导致不再报错，tsc 会以「未使用的 @ts-expect-error」报错）；
 * - getAux 未写入时返回 undefined；
 * - 确定性：aux 参与与否不改变几何——同 seed 两次生成深相等，
 *   写 aux 与不写 aux 的同几何积木产出相同内容指纹。
 */
import { describe, expect, it } from "vitest";

import { createGeneratorRegistry, type GeneratorRegistry } from "map/generate/generatorRegistry";
import { buildMapGeometry } from "map/generate/pipeline";
import { heightChannel } from "map/generate/blocks/heightChannel";
import { heightMask } from "map/generate/blocks/heightMask";
import {
  createGeometryDraft,
  defineAuxSlot,
  getAux,
  setAux,
  type AuxSlot,
  type GeometryDraft,
  type MapGenerationConfig,
} from "map/generate/types";

/** 测试槽位 A：承载 string。 */
const NOTES = defineAuxSlot<string>("test:notes");

/** 测试槽位 B：承载 number[]（与 A 跨 T，供编译期防错配断言）。 */
const COUNTS = defineAuxSlot<number[]>("test:counts");

/** 把草稿填充为合法最小图（2×2，单区域全覆盖）。 */
function fillDraft(draft: GeometryDraft): void {
  fillDraftSized(draft, 2, 2);
}

/** 按尺寸填充合法草稿（单区域全覆盖、全部可走）。 */
function fillDraftSized(draft: GeometryDraft, width: number, height: number): void {
  const total = width * height;
  draft.width = width;
  draft.height = height;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(total);
  draft.walkable = new Uint8Array(total).fill(1);
  draft.regions.set("region-a", { name: "region-a", meta: {} });
  draft.regionOfTile = new Uint16Array(total);
}

/** 注册真实内置积木（height-channel 生产 / height-mask 消费）。 */
function makeRealAuxRegistry(): GeneratorRegistry {
  const registry = createGeneratorRegistry();
  registry.register("sizing", (ctx) => fillDraftSized(ctx.geometry, 16, 16));
  registry.register("height-channel", heightChannel);
  registry.register("height-mask", heightMask);
  return registry;
}

/** 构造注册了给定积木的注册表（积木体只拿草稿，屏蔽上下文细节）。 */
function makeRegistry(
  entries: Array<[string, (draft: GeometryDraft) => void]>,
): GeneratorRegistry {
  const registry = createGeneratorRegistry();
  for (const [id, body] of entries) {
    registry.register(id, (ctx) => body(ctx.geometry));
  }
  return registry;
}

describe("aux 生命周期：仅管道执行期，冻结时丢弃", () => {
  it("POSITIVE：积木内写入 aux，冻结后的 MapGeometry 无 aux（类型层 + 运行时）", () => {
    const registry = makeRegistry([
      ["writer", (draft) => {
        fillDraft(draft);
        setAux(draft, NOTES, "midway-artifact");
      }],
    ]);

    const geometry = buildMapGeometry(
      { key: "aux-map", seed: 1, pipeline: [{ generator: "writer" }] },
      registry,
    );

    // 类型层：MapGeometry 无 aux 字段——@ts-expect-error 由 pnpm build
    // （tsc 全量编译）验证；若未来有人给 MapGeometry 加回 aux 字段，
    // 该指令失效会导致 build 失败，守住「冻结丢弃」契约
    // @ts-expect-error MapGeometry 类型层不存在 aux 字段
    expect(geometry.aux).toBeUndefined();
    // 运行时：冻结对象无 aux 自有属性，无泄漏
    expect(Object.hasOwn(geometry, "aux")).toBe(false);
    expect("aux" in geometry).toBe(false);
  });

  it("POSITIVE：aux 在管道积木间传递（上游写、下游读）", () => {
    let seen: string | undefined;
    const registry = makeRegistry([
      ["upstream", (draft) => setAux(draft, NOTES, "shared-artifact")],
      ["downstream", (draft) => {
        seen = getAux(draft, NOTES);
        fillDraft(draft);
      }],
    ]);

    buildMapGeometry(
      {
        key: "relay-map",
        seed: 1,
        pipeline: [{ generator: "upstream" }, { generator: "downstream" }],
      },
      registry,
    );

    expect(seen).toBe("shared-artifact");
  });
});

describe("branded 槽位：编译期类型隔离", () => {
  it("POSITIVE：同槽位常量 setAux → getAux 读写往返，同槽覆盖", () => {
    const draft = createGeometryDraft("roundtrip");
    setAux(draft, NOTES, "payload");
    expect(getAux(draft, NOTES)).toBe("payload");
    setAux(draft, NOTES, "replaced");
    expect(getAux(draft, NOTES)).toBe("replaced");
  });

  it("NEGATIVE：跨 T 的槽位常量相互赋值是编译错误（@ts-expect-error）", () => {
    // @ts-expect-error 不同 T 的 branded 槽位互不兼容（brand 字段类型不匹配）
    const mismatched: AuxSlot<string[]> = COUNTS;
    expect(mismatched.name).toBe("test:counts");
  });

  it("NEGATIVE：跨 T 的槽位值传递是编译错误（@ts-expect-error）", () => {
    const draft = createGeometryDraft("cross-slot");
    setAux(draft, COUNTS, [7]);
    // @ts-expect-error number[] 槽读出的值不可写入 string 槽
    setAux(draft, NOTES, getAux(draft, COUNTS));
  });

  it("NEGATIVE：无品牌标记的裸对象不可充当槽位（@ts-expect-error）", () => {
    // @ts-expect-error 缺少 brand 字段，裸对象不可赋给 branded 槽位
    const bare: AuxSlot<string> = { name: "test:bare" };
    expect(bare.name).toBe("test:bare");
  });
});

describe("getAux 缺省语义与确定性", () => {
  it("POSITIVE：getAux 未写入时返回 undefined", () => {
    const draft = createGeometryDraft("empty-aux");
    expect(getAux(draft, NOTES)).toBeUndefined();
  });

  it("POSITIVE：同 seed 两次 buildMapGeometry 输出一致（积木写 aux 不改变几何）", () => {
    const registry = makeRegistry([
      ["gen", (draft) => {
        fillDraft(draft);
        setAux(draft, NOTES, "aux-payload");
      }],
    ]);
    const config: MapGenerationConfig = {
      key: "det-map",
      seed: 42,
      pipeline: [{ generator: "gen" }],
    };

    const a = buildMapGeometry(config, registry);
    const b = buildMapGeometry(config, registry);
    expect(b).toEqual(a);
  });

  it("POSITIVE：写 aux 与不写 aux 的同几何积木产出相同内容指纹", () => {
    const plain = makeRegistry([["gen", (draft) => fillDraft(draft)]]);
    const withAux = makeRegistry([
      ["gen", (draft) => {
        fillDraft(draft);
        setAux(draft, NOTES, "aux-payload");
      }],
    ]);
    const config: MapGenerationConfig = {
      key: "fp-map",
      seed: 42,
      pipeline: [{ generator: "gen" }],
    };

    const a = buildMapGeometry(config, plain);
    const b = buildMapGeometry(config, withAux);
    expect(b.version).toBe(a.version);
    expect(b).toEqual(a);
  });
});

describe("aux 品牌运行时：brand 只在编译期，运行期按槽位名索引", () => {
  it("同名常量共享存储（brand 无运行时作用）；不同名槽位互不可见", () => {
    const slotA = defineAuxSlot<string>("same.name");
    const slotB = defineAuxSlot<string>("same.name");
    expect(slotA).not.toBe(slotB); // 对象身份不同
    expect(slotA.name).toBe(slotB.name);

    const draft = createGeometryDraft("identity");
    setAux(draft, slotA, "from-a");
    expect(getAux(draft, slotA)).toBe("from-a");
    // 运行期键是 name：同名（即使常量不同）读到同一份数据
    expect(getAux(draft, slotB)).toBe("from-a");
    // 不同名槽位隔离
    const other = defineAuxSlot<string>("other.name");
    expect(getAux(draft, other)).toBeUndefined();
  });
});

describe("内置 height-channel → height-mask：真实积木的 aux 生产/消费闭环", () => {
  it("POSITIVE：上游写场、下游改 walkable；冻结几何无 aux 且同 seed 可复现", () => {
    const registry = makeRealAuxRegistry();
    const config: MapGenerationConfig = {
      key: "aux-builtin",
      seed: 7,
      pipeline: [
        { generator: "sizing" },
        { generator: "height-channel", params: { cell: 3 } },
        { generator: "height-mask", params: { mode: "mask", minLevel: 0.5 } },
      ],
    };

    const a = buildMapGeometry(config, registry);
    const b = buildMapGeometry(config, registry);
    expect(b).toEqual(a);
    expect(Object.hasOwn(a, "aux")).toBe(false);

    // height-mask 真实改写了通行位：16×16 噪声场在 0.5 阈值下必然同时有 0/1
    const values = new Set(a.walkable);
    expect(values.has(1)).toBe(true);
    expect(values.has(0)).toBe(true);
  });

  it("NEGATIVE：下游缺少上游 height-channel → 抛错点名依赖", () => {
    const registry = createGeneratorRegistry();
    registry.register("sizing", (ctx) => fillDraftSized(ctx.geometry, 4, 4));
    registry.register("height-mask", heightMask);

    expect(() =>
      buildMapGeometry(
        {
          key: "aux-missing-upstream",
          seed: 1,
          pipeline: [
            { generator: "sizing" },
            { generator: "height-mask", params: { mode: "mask" } },
          ],
        },
        registry,
      ),
    ).toThrowError(/height-mask requires an upstream "height-channel"/);
  });
});
