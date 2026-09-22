/**
 * tile-units 单位归一化（tile-units 机制，纯机制级——无任何业务语义）。
 *
 * 配置允许以「格」为空间量纲表达量：键名精确以 `Tiles` 结尾（大小写敏感）
 * 即声明该值为格数。加载期（loadGameDefinition）对目标配置树做一次原地深度
 * 转换：`xTiles` → 裸键 `x`，值 = 原值 × 全局 tile 像寸（world.tile.width），
 * 并删除 `Tiles` 键。px 是运行时唯一形态——运行时系统零改动。
 *
 * 量纲语义由字段自身继承：距离量（格 → px）与速度量（格/秒 → px/秒）共用
 * 同一换算规则——后缀只声明空间量纲，时间单位不变，无需按语义特判。
 *
 * 校验（fail-fast，错误消息含配置树内路径）：
 * - `Tiles` 值必须为有限数 ≥ 0，否则抛配置错误；
 * - 同一对象内 px 裸键与 `Tiles` 键并存 → 抛错（转换前检测，与键序无关）；
 * - px 裸键写法保持合法（两套并存、渐进迁移），无 `Tiles` 键的结构原样透传。
 */

/** Tiles 后缀（精确匹配、大小写敏感）。 */
const TILES_SUFFIX = "Tiles";

/** 渲染配置树内路径：根对象显示为 "<root>"，其余为点分路径（数组下标 [i]）。 */
function formatPath(path: string): string {
  return path === "" ? "<root>" : path;
}

/** 子节点路径拼接。 */
function childPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/** 非法值的可读描述（错误消息定位用）。 */
function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "an array";
  if (value !== null && typeof value === "object") return "an object";
  return String(value);
}

/** 递归遍历配置树（对象 + 数组）：冲突检测 → 转换 → 深入子节点。 */
function walk(node: unknown, path: string, tilePx: number): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walk(node[i], `${path}[${i}]`, tilePx);
    }
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const objectPath = formatPath(path);

  // 冲突检测先于转换（与键序无关）：同一对象内 px 裸键与 Tiles 键并存即抛错
  for (const key of Object.keys(obj)) {
    if (!key.endsWith(TILES_SUFFIX)) continue;
    const bare = key.slice(0, -TILES_SUFFIX.length);
    if (Object.prototype.hasOwnProperty.call(obj, bare)) {
      throw new Error(
        `tile-units: conflicting keys "${bare}" and "${key}" at "${objectPath}" — ` +
          "a px key and its Tiles counterpart cannot coexist in the same object",
      );
    }
  }

  // 转换：裸键 = 去后缀，值 = 原值 × tilePx，删除 Tiles 键（px 是运行时唯一形态）
  for (const key of Object.keys(obj)) {
    if (!key.endsWith(TILES_SUFFIX)) continue;
    const bare = key.slice(0, -TILES_SUFFIX.length);
    const value = obj[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(
        `tile-units: value at "${childPath(path, key)}" must be a finite number >= 0, ` +
          `got ${describeValue(value)}`,
      );
    }
    obj[bare] = value * tilePx;
    delete obj[key];
  }

  // 递归子节点（当前键快照；转换产物为数值，不会二次处理同一对象）
  for (const key of Object.keys(obj)) {
    const child = obj[key];
    if (child !== null && typeof child === "object") {
      walk(child, childPath(path, key), tilePx);
    }
  }
}

/**
 * 原地深度转换配置树中的 `*Tiles` 量纲键（§3.2）。
 *
 * 遍历对象与数组：键名精确以 `Tiles` 结尾 → 裸键 = 去后缀，
 * 值 = 原值 × tilePx，删除 `Tiles` 键。值必须为有限数 ≥ 0；同一对象内
 * px 裸键与 Tiles 键并存、或值非法 → 抛含路径的配置错误。px 裸键写法
 * 透传不变，无 `Tiles` 键的结构原样通过（原地转换，不复制、不改引用）。
 *
 * @param root 目标配置树（任意 JSON 值；非对象/数组则无事发生）
 * @param tilePx 全局 tile 像寸（world.tile.width，`*Tiles` 换算的唯一基准）
 */
export function normalizeTileUnits(root: unknown, tilePx: number): void {
  if (typeof tilePx !== "number" || !Number.isFinite(tilePx) || tilePx <= 0) {
    throw new Error(`tile-units: tilePx must be a finite number > 0, got ${String(tilePx)}`);
  }
  walk(root, "", tilePx);
}
