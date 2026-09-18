/**
 * 每图随机种子表（framework/map/runtime/mapSeeds.ts）——新档随机种子入口
 * （map-system 设计 §5.4 修复项 4）的运行时载体。
 *
 * seed 解析流程（唯一归属地 = bootMaps）：
 * `record?.mapSeeds?.[key] ?? config.seed ?? randomUint32()`，两条开机分支
 * （快照回填 / 新生成）统一解析并写入本表；serializeWorld 据此把解析结果
 * 写入 WorldRecord.mapSeeds 固化，读档路径从快照回读——读档不重建几何，
 * 但每 tick / 离线补差的演化选点流必须与存档世界同源，故 restore 分支的
 * seed 同样进本表供 GameSimulation 读取。
 *
 * 为什么是 WeakMap 而非 GameWorld 字段：WorldRecord 序列化只看得到 world，
 * 而 seed 解析结果是开机编排（bootMaps）的产物——挂在模块侧弱表既让
 * serializeWorld / GameSimulation 经 world 取到解析结果，又不给 GameWorld
 * 核心结构加字段（world 按 WeakMap 生命周期自动回收）。
 */
import type { GameWorld } from "framework/world";

/** world → 已解析的每图 seed 表（key = 地图 registry key）。 */
const seedsByWorld = new WeakMap<GameWorld, Record<string, number>>();

/** 记录一个 world 的每图 seed 解析结果（bootMaps 开机分支唯一写入点）。 */
export function setMapSeeds(world: GameWorld, seeds: Record<string, number>): void {
  seedsByWorld.set(world, seeds);
}

/** 读一个 world 的每图 seed 表；未开机（bootMaps 未跑）返回 undefined。 */
export function getMapSeeds(world: GameWorld): Readonly<Record<string, number>> | undefined {
  return seedsByWorld.get(world);
}

/** 读某图的解析 seed；图不在表内返回 undefined（调用方自行回退配置值）。 */
export function mapSeedOf(world: GameWorld, mapKey: string): number | undefined {
  return seedsByWorld.get(world)?.[mapKey];
}

/**
 * 随机 32 位无符号种子（配置缺省 seed 且无快照固化值时的兜底）。
 * 每图独立调用——同一次开机内各图 seed 互不相关。
 */
export function randomUint32(): number {
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}
