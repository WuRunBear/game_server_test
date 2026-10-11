/**
 * 族群节点组件与确定性参数解析（framework/simulation/population）——游戏无关。
 *
 * ## 为什么是「节点」而不是真实食物链
 *
 * 行业结论：主流生存游戏不跑真食物链，「生态感」来自**可穷尽 + 有反馈**。
 * 本模块把一处种群抽象为一个**记账节点**：一个巢穴/兽群/聚落实体身上挂一条
 * `Population` 数据，服务端只演进它的数量数值；玩家靠近时实例化为真实实体
 * 属后续切片（本切片不做视野实例化）。节点随来源实体存亡——来源实体被销毁
 * 即节点条目消失，该处**永久停产**（destroyEntity 会清理全部 AoS 残留）。
 *
 * ## 数据模型
 *
 * 持久 AoS 组件 `Population[eid] = PopulationNodeState`：普通 JS 数组按 eid
 * 索引，不是 bitecs SoA 组件——不能 addComponent / 不能进 query。它承载：
 * 物种 kind（species）、当前数量（count）、上限（cap）、增长参数
 * （growthRate / growthIntervalTicks）、归属区域（homeRegion）、最后演进 tick
 * （lastEvolvedTick）与**来源标识**（sourceKind = 来源实体原型 kind）。
 *
 * 随实体入档（worldSerializer 的 AoS 分支整体 structuredClone / 回填）；
 * **不注册 netSync 适配器**——节点是纯服务端权威记账，客户端不需要（快照
 * 构建对未注册适配器的 AoS 组件静默跳过，见 aosSyncAdapters.ts）。
 *
 * ## 配置形态（archetype 的 `Population` 组件块）
 *
 * - `species`（必填非空）：产出的实体原型 kind（archetypes 注册表引用）。
 * - `carryingDensity`：每 tile 承载力密度；`cap = floor(区域面积 × carryingDensity)`。
 *   承载力依赖**真实区域数据**（区域面积，见 regionAreaOf），非写死常量。
 * - `growthRate`：每个增长周期期望新增个体数（可为小数——小数部分经确定性
 *   随机流按周期掷骰，见 growthForSlot）。
 * - `growthIntervalTicks`：增长周期（tick）。
 * - `homeRegion`：归属区域名（MapGeometry.regions 键）；空串时在首次演进时
 *   由实体所在 tile 的区域惰性解析。
 * - `count`：初始数量（缺省 0）。
 * - `spawnInstances`：可选的**最小生产通路**开关（缺省 false）：为 true 时
 *   族群系统在来源实体周围把 species 实体补足到 count（本切片不做视野实例化，
 *   该通路是无视野门控的记账→实体落地，后续切片的可见实例化复用/替换它）。
 */
import { Kind } from "framework/components/kind";
import { entityMapOf } from "framework/components/entityMap";
import { NetworkId } from "framework/components/network";
import { Transform } from "framework/components/transform";
import { rngFrom } from "framework/simulation/rng";
import { regionOf } from "map/geometry/query";
import type { MapGeometry } from "map/geometry/types";
import type { GameWorld } from "framework/world";

/** 族群节点状态（持久 AoS 结构）。 */
export interface PopulationNodeState {
  /** 产出的实体原型 kind（species；archetypes 注册表引用）。 */
  species: string;
  /** 当前族群数量（服务端权威记账值；非存活实体计数）。 */
  count: number;
  /** 数量上限（承载力镜像；每次演进按区域面积重算，不读配置）。 */
  cap: number;
  /** 每 tile 承载力密度（配置值；cap = floor(区域面积 × carryingDensity)）。 */
  carryingDensity: number;
  /** 每个增长周期期望新增个体数（配置值；小数部分确定性掷骰）。 */
  growthRate: number;
  /** 增长周期（tick；配置值，≥1）。 */
  growthIntervalTicks: number;
  /** 归属区域名；空串 = 首次演进时由实体所在 tile 惰性解析。 */
  homeRegion: string;
  /** 最后演进到的绝对 tick。 */
  lastEvolvedTick: number;
  /** 来源标识：产出/承载本节点的实体原型 kind（惰性由实体 Kind 填充）。 */
  sourceKind: string;
  /** 最小生产通路开关（缺省 false，见文件头）。 */
  spawnInstances: boolean;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const Population = [] as (PopulationNodeState | undefined)[];

/** 配置形态（archetype 组件块；宽松读入，非法值 fail-fast 或钳制）。 */
interface PopulationConfig {
  species?: unknown;
  carryingDensity?: unknown;
  growthRate?: unknown;
  growthIntervalTicks?: unknown;
  homeRegion?: unknown;
  count?: unknown;
  spawnInstances?: unknown;
}

/** 读世界当前 tick（world 形态宽松——初始化钩子对 world 泛化）。 */
function tickOf(world: unknown): number {
  const time = (world as { time?: { tick?: unknown } } | undefined)?.time;
  return typeof time?.tick === "number" ? time.tick : 0;
}

/** 有限非负数值收窄；非法回退缺省。 */
function nonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * AoS archetype 初始化钩子：归一化原型配置并 fail-fast。
 *
 * - species：必填非空字符串（缺失/空串抛错——配置错误尽早暴露）
 * - carryingDensity / growthRate：有限非负数（非法回退 0）
 * - growthIntervalTicks：向下取整并钳到 ≥ 1
 * - count：向下取整并钳到 ≥ 0
 * - cap：初始 0（首次演进按区域面积重算）
 * - lastEvolvedTick：= world.time.tick（生成时刻；initialAge 期间的补差由
 *   首次演进自然完成）
 */
export function initPopulation(world: unknown, eid: number, config: unknown): void {
  const cfg = (config ?? {}) as PopulationConfig;
  const species = typeof cfg.species === "string" ? cfg.species : "";
  if (species === "") {
    throw new Error(`Population component requires a non-empty "species" string (entity ${eid})`);
  }
  const carryingDensity = nonNegative(cfg.carryingDensity, 0);
  const growthRate = nonNegative(cfg.growthRate, 0);
  const growthIntervalTicks =
    typeof cfg.growthIntervalTicks === "number" && Number.isFinite(cfg.growthIntervalTicks)
      ? Math.max(1, Math.floor(cfg.growthIntervalTicks))
      : 1;
  const count = nonNegative(cfg.count, 0);
  Population[eid] = {
    species,
    count: Math.floor(count),
    cap: 0,
    carryingDensity,
    growthRate,
    growthIntervalTicks,
    homeRegion: typeof cfg.homeRegion === "string" ? cfg.homeRegion : "",
    lastEvolvedTick: tickOf(world),
    sourceKind: "",
    spawnInstances: cfg.spawnInstances === true,
  };
}

/**
 * 统计区域面积（承载力依据）——**真实区域数据**，非写死值。
 *
 * 优先读 `RegionMeta.meta.area`（地图生成积木 region-stats 写入的区域格数），
 * 缺失时回退按 regionOfTile 逐格计数（区域索引 = regions Map 插入序）。
 * 区域未注册返回 0（承载为 0 = 该处不增长）。
 */
export function regionAreaOf(geometry: MapGeometry, region: string): number {
  const declared = geometry.regions.get(region)?.meta?.["area"];
  if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) {
    return declared;
  }
  let regionIndex = -1;
  let index = 0;
  for (const name of geometry.regions.keys()) {
    if (name === region) {
      regionIndex = index;
      break;
    }
    index += 1;
  }
  if (regionIndex < 0) return 0;
  let count = 0;
  for (let i = 0; i < geometry.regionOfTile.length; i++) {
    if (geometry.regionOfTile[i] === regionIndex) count += 1;
  }
  return count;
}

/**
 * 单个增长周期的确定性增量（纯函数）。
 *
 * growthRate 的整数部分恒定增长；小数部分由 `(seed, source, period)` 经统一
 * 随机服务派生的**确定性**随机流按概率掷出 1——同输入恒同结果，且离线快进
 * 逐周期重放与在线逐 tick 完全一致（不使用 Math.random）。
 *
 * @param seed 世界/本图 seed（mapSeeds 弱表解析值）
 * @param sourceKind 来源原型 kind（随机流作用域，隔离不同物种/巢穴）
 * @param sourceId 来源稳定标识（来源实体 networkId；跨存读档不变）
 * @param period 绝对增长周期序号（cap 达到前的第 N 个周期）
 * @param growthRate 每周期期望新增
 */
export function growthForSlot(
  seed: number,
  sourceKind: string,
  sourceId: number,
  period: number,
  growthRate: number,
): number {
  const base = Math.floor(growthRate);
  const fraction = growthRate - base;
  if (fraction <= 0) return base;
  const roll = rngFrom(seed, "population", sourceKind, sourceId, period).next();
  return base + (roll < fraction ? 1 : 0);
}

/**
 * 解析节点归属区域：优先配置 homeRegion，空串时按实体所在 tile 惰性解析并回写。
 * 无几何（无图世界/图未解析）返回空串。
 */
export function resolveHomeRegion(world: GameWorld, eid: number, geometry?: MapGeometry): string {
  const node = Population[eid];
  if (!node) return "";
  if (node.homeRegion !== "") return node.homeRegion;
  if (!geometry) return "";
  const tx = Math.floor(Transform.x[eid] / geometry.grid.tileWidth);
  const ty = Math.floor(Transform.y[eid] / geometry.grid.tileHeight);
  node.homeRegion = regionOf(geometry, tx, ty) ?? "";
  return node.homeRegion;
}

/** 取来源实体的稳定标识（networkId；跨存读档不变，供随机流作用域与来源追踪）。 */
export function populationSourceId(eid: number): number {
  return NetworkId.value[eid] ?? 0;
}

/** 惰性填充来源标识（来源原型 kind）——init 钩子阶段 Kind 尚未写入，故延后。 */
export function resolveSourceKind(world: GameWorld, eid: number): string {
  const node = Population[eid];
  if (!node) return "";
  if (node.sourceKind === "") node.sourceKind = Kind[eid] ?? "";
  return node.sourceKind;
}

/**
 * 节点所属图几何：按实体 EntityMap 解析；无图/未解析返回 undefined。
 * 与刷怪/演化链同一归属语义（effectiveMapOf），此处只读不写不记错。
 */
export function populationGeometryOf(world: GameWorld, eid: number): MapGeometry | undefined {
  const mapKey = entityMapOf(world, eid);
  return mapKey === "" ? undefined : world.maps[mapKey];
}
