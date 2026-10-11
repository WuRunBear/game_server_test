/**
 * 系统层确定性随机服务（framework/simulation/rng）——框架内部所有 gameplay
 * 随机流的**唯一派生入口**（游戏无关）。
 *
 * 设计契约：分流种子按 `(seed, 作用域…, attempt)` 派生——同输入恒产生同序列，
 * 异作用域/异 attempt 序列互不相关。作用域可以是 eid / channel 名 / kind 等；
 * attempt 是同一作用域内的第 N 次取值。底层 PRNG 复用 map/generate/rng 的
 * mulberry32 + xmur3（零新依赖）。
 *
 * 两条派生风格：
 * - `attemptSeed` / `attemptRng`：整数混叠 `(tick, eid, channel, attempt)`。算法与
 *   历史上 `spawnPlacement.attemptSeed` 的实现**逐位一致**（nest/raid 的精确落点
 *   断言依赖此不变式）。
 * - `mixSeed` / `rngFrom`：任意数值/字符串分量经 FNV-1a 串行混叠，供 kind、区域名
 *   等字符串作用域使用（死亡掉落掷骰、丢弃散布、AI 游荡等）。
 */
import { createRng, type Rng } from "framework/map/generate/rng";

export type { Rng };

/** 单个种子分量：数值（tick/eid/attempt…）或字符串作用域名（kind/channel…）。 */
export type SeedPart = number | string;

/**
 * FNV-1a 32 位混叠：把任意分量按给定顺序串行散列为 32 位种子（纯函数、顺序敏感）。
 * 数值分量与字符串分量加不同前缀标记，避免 `12` 与 `"12"` 碰撞。
 */
export function mixSeed(...parts: SeedPart[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const token = typeof part === "number" ? `n${part >>> 0}` : `s${part}`;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    // 分量分隔符：防 ("ab","c") 与 ("a","bc") 得到同一串
    hash ^= 0x2f;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 由任意分量派生确定性随机流（同输入恒同序列）。 */
export function rngFrom(...parts: SeedPart[]): Rng {
  return createRng(mixSeed(...parts));
}

/**
 * 确定性尝试种子：把 `(tick, eid, slot, attempt)` 混叠为一个 32 位整数。
 * 只求确定性（同输入恒同序列）；散列碰撞仅意味着两档尝试复用同一随机序列，无害。
 *
 * **算法与参数顺序保持不变**——历史 `spawnPlacement.attemptSeed` 的调用方
 * （nest/raid）依赖逐位一致的落点序列。
 */
export function attemptSeed(tick: number, eid: number, slot: number, attempt: number): number {
  return (
    Math.imul(tick, 2654435761) ^
    Math.imul(eid, 40503) ^
    Math.imul(slot, 7919) ^
    Math.imul(attempt, 97)
  ) >>> 0;
}

/**
 * 由 `(tick, eid, channel, attempt)` 取确定性随机流（简洁系统 API）。
 * 与 `createRng(attemptSeed(tick, eid, channel, attempt))` 逐位等价。
 */
export function attemptRng(tick: number, eid: number, channel: number, attempt: number): Rng {
  return createRng(attemptSeed(tick, eid, channel, attempt));
}
