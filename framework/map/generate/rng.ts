/**
 * 可复现的种子随机数（framework/map/generate/rng.ts）。
 *
 * xmur3（字符串种子散列）+ mulberry32（32 位 PRNG）组合，纯函数、零依赖：
 * 同 seed 恒产生同一序列，异 seed 序列不同。管道每个步骤经 deriveStream
 * 从「总 seed + 步骤序号」派生独立流——步骤增删不影响其他步骤的序列。
 */

/** 生成层随机数流接口：均匀浮点 + 整数取值。 */
export interface Rng {
  /** 下一个 [0, 1) 均匀浮点。 */
  next(): number;
  /** 下一个 [0, maxExclusive) 均匀整数（maxExclusive 须为正）。 */
  int(maxExclusive: number): number;
}

/**
 * xmur3 字符串散列：把种子字符串混叠为一个 32 位种子生成器。
 *
 * @param source 种子字符串
 * @returns 每次调用返回一个 32 位无符号种子值
 */
function xmur3(source: string): () => number {
  let h = 1779033703 ^ source.length;
  for (let i = 0; i < source.length; i++) {
    h = Math.imul(h ^ source.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/**
 * mulberry32 PRNG：给定 32 位种子，返回确定性的 [0, 1) 浮点序列。
 *
 * @param a 32 位种子
 * @returns 序列生成函数
 */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 由种子字符串构建 Rng 实例（内部共用路径）。 */
function rngFrom(seedSource: string): Rng {
  const next = mulberry32(xmur3(seedSource)());
  return {
    next: () => next(),
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
  };
}

/**
 * 由数值种子创建随机流（同 seed 同序列，异 seed 异序列）。
 *
 * @param seed 数值种子
 * @returns Rng
 */
export function createRng(seed: number): Rng {
  return rngFrom(String(seed));
}

/**
 * 从总 seed 派生某管道步骤的独立随机流。
 *
 * 派生键为 `"<totalSeed>:<stepIndex>"` 字符串——步骤序号不同则流不同，
 * 同 (totalSeed, stepIndex) 恒产生同一序列（确定性 + 步骤间独立）。
 *
 * @param totalSeed 地图总种子
 * @param stepIndex 管道步骤序号（从 0 起）
 * @returns 该步骤专属的 Rng
 */
export function deriveStream(totalSeed: number, stepIndex: number): Rng {
  return rngFrom(`${totalSeed}:${stepIndex}`);
}
