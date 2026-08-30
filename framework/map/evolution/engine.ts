/**
 * 补差引擎（framework/map/evolution/engine.ts）。
 *
 * 全系统唯一产生实体的决策路径：把世界从 fromTick 推演到 toTick。三个时机
 * （开机 0→initialAge / 每 tick 增量 / 读档离线补差）是**同一个 evolve 喂不同
 * 跨度**——引擎内部对场景零分支，不持久化任何状态。
 *
 * timeSlot 绝对对齐：s = k×every（k≥1）且 fromTick < s ≤ toTick 的槽才被本
 * 调用处理（槽在 s 时刻完成一个周期）——任意分段推演与一次推演覆盖的槽集合
 * 恒等，且开机/每 tick/离线补差三链路无缝衔接不重不漏。
 *
 * 处理序 = **槽时刻升序 × 同槽按规则数组序**（对各规则的槽序列做 k 路合并）。
 * 这是 U2 等价性的根基：占用状态跨规则共享，若按规则优先序处理，混合 every
 * 的规则槽会随分段边界交错出不同的全局序，导致选点输入漂移；按槽时刻合并后
 * 全局处理序与分段方式无关。
 *
 * 单次调用内引擎只增不删（死亡归 deathSystem、拆除归 deconstructSystem），
 * countByKind 单调不减 → 每条规则在其首个槽查询一次计数后本地跟踪；一旦
 * count ≥ max 立即退出该规则剩余全部 timeSlot（早退不变式，长跨度成本有界）。
 * 计数查询惰性到首个槽：同图同 kind 的多条规则按槽序处理时，后者的计数才能
 * 反映前者本调用内的产出。
 *
 * 读经 deps 注入（countByKind/isOccupied——真实实现 = bitecs query + Kind +
 * EntityMap + GridOccupancy，须反映本调用此前的 spawn 结果），引擎不做任何
 * 直接组件查询；写唯一通道 = deps.spawn（缺省实现走 spawnEntity 链，无旁路）。
 *
 * condition 每 evolve 调用对每条规则求值一次（经 spawnConditions 注册表，
 * 未注册条件名抛错——配置错误尽早暴露）；求值结果对本调用内全部 timeSlot
 * 生效，不做逐时段历史相位（I3 已声明的设计近似）。
 */
import { spawnEntity } from "framework/entities/spawn";
import { getSpawnCondition } from "framework/systems/gameplay/spawnConditions";
import { createLogger } from "framework/utils/logger";
import type { GameWorld } from "framework/world";
import { walkableAt } from "map/geometry/query";
import type { MapGeometry } from "map/geometry/types";
import { pickPoint, placementCandidates } from "map/evolution/placement";
import type { DensityRule, EntityRule, ExactRule, TemplateRule } from "map/evolution/schema";
import { ruleIdentity } from "map/evolution/schema";

/** 演化日志器（游戏无关 scope）。 */
const logger = createLogger("map-evolution");

/** 实体写入通道：在 mapKey 图的 (x, y) tile 生成一个 kind 实体。 */
export type SpawnFn = (kind: string, mapKey: string, x: number, y: number) => void;

/** 演化依赖注入：读经回调、写经 spawn（缺省走 spawnEntity 链）。 */
export interface EvolutionDeps {
  /** 选点流种子（地图配置 seed 经 deps 注入；同 seed 同候选序列，U4）。 */
  seed: number;
  /** 统计 mapKey 图 region 区域内 kind 实体数（须单调反映本调用的 spawn）。 */
  countByKind(mapKey: string, region: string, kind: string): number;
  /** tile 是否被占用（须反映本调用此前的 spawn 结果——同槽多次补足依赖它去重）。 */
  isOccupied(mapKey: string, x: number, y: number): boolean;
  /** 实体写入通道；缺省实现 = spawnEntity（overrides.mapId → EntityMap[eid]=mapKey）。 */
  spawn?: SpawnFn;
}

/** 模式分派辅助函数的共享上下文（单次 evolve 调用内不变）。 */
interface EvolutionContext {
  geometry: MapGeometry;
  mapKey: string;
  ruleId: string;
  seed: number;
  spawn: SpawnFn;
  isOccupied: (x: number, y: number) => boolean;
}

/** 活跃规则游标：k 路合并的处理单元。 */
interface RuleCursor {
  ctx: EvolutionContext;
  rule: EntityRule;
  /** 区域内 kind 实体数；null = 尚未查询（惰性到首个槽）。 */
  count: number | null;
  /** 下一个待处理槽（绝对对齐）；Infinity = 已早退/耗尽。 */
  nextSlot: number;
}

/** 缺省写入通道：唯一真实实现，经 spawnEntity 生成（无任何旁路）。 */
function createDefaultSpawn(world: GameWorld): SpawnFn {
  return (kind, mapKey, x, y) => {
    const archetype = world.archetypes.get(kind);
    // overrides.mapId 使 spawnEntity 内部写 EntityMap[eid] = mapKey
    // （AoS 写入约定见 components/entityMap.ts，此处不重复写）。
    spawnEntity(world, archetype, world.components_registry, { x, y, mapId: mapKey });
  };
}

/**
 * density 补足：逐个确定性选点生成，直至补满 need 或候选耗尽。
 *
 * 候选耗尽即放弃本槽剩余补足——同流同占用（未新增任何实体）下重试必同样
 * 失败，不会死循环。返回本槽新增的 rule.kind 实体数。
 */
function spawnDensity(rule: DensityRule, need: number, ctx: EvolutionContext, slot: number): number {
  let spawned = 0;
  for (let i = 0; i < need; i++) {
    const point = pickPoint(ctx.geometry, rule.region, ctx.ruleId, slot, ctx.seed, ctx.isOccupied);
    if (!point) break;
    ctx.spawn(rule.kind, ctx.mapKey, point.x, point.y);
    spawned += 1;
  }
  return spawned;
}

/**
 * exact 补足：固定落点 at，每 timeSlot 至多尝试一次（同一落点单槽内至多
 * 合法容纳一个实体）。落点非法（不可走或被占用）→ 跳过并 warn；
 * 静态 exact 项的落点合法性由开机校验兜底（见计划 todo 9/11）。
 */
function spawnExact(rule: ExactRule, ctx: EvolutionContext, slot: number): number {
  const { x, y } = rule.at;
  if (walkableAt(ctx.geometry, x, y) && !ctx.isOccupied(x, y)) {
    ctx.spawn(rule.kind, ctx.mapKey, x, y);
    return 1;
  }
  logger.warn("evolution: exact landing illegal, placement skipped", {
    map: ctx.mapKey,
    rule: ctx.ruleId,
    kind: rule.kind,
    x,
    y,
    tick: slot,
  });
  return 0;
}

/**
 * template 补足：确定性选模板原点，**先校验整组落点**（全部可走、未被占用、
 * 组内不共格）——全部合法才成组生成；任一非法换下一候选原点（候选序列不变，
 * 占用只过滤），候选耗尽则整组放弃（永不产生半座结构）。
 *
 * 返回本槽新增的锚 kind（rule.kind）实体数 = 成组数 × 每组锚条目数。
 */
function spawnTemplate(rule: TemplateRule, groups: number, ctx: EvolutionContext, slot: number): number {
  const anchorPerGroup = rule.template.filter((entry) => entry.kind === rule.kind).length;
  let placed = 0;
  for (let g = 0; g < groups; g++) {
    let placedThisGroup = false;
    for (const origin of placementCandidates(ctx.geometry, rule.region, ctx.ruleId, slot, ctx.seed)) {
      const parts = rule.template.map((entry) => ({
        kind: entry.kind,
        x: origin.x + entry.dx,
        y: origin.y + entry.dy,
      }));
      const distinct = new Set(parts.map((p) => `${p.x},${p.y}`)).size === parts.length;
      const allLegal =
        distinct && parts.every((p) => walkableAt(ctx.geometry, p.x, p.y) && !ctx.isOccupied(p.x, p.y));
      if (!allLegal) continue;
      for (const part of parts) {
        ctx.spawn(part.kind, ctx.mapKey, part.x, part.y);
      }
      placedThisGroup = true;
      break;
    }
    if (!placedThisGroup) break;
    placed += 1;
  }
  return placed * anchorPerGroup;
}

/**
 * 把世界从 fromTick 推演到 toTick（单图：只处理 rule.map === geometry.key 的
 * 规则）。toTick 不大于 fromTick 时空转（离线折算为 0 的读档场景自然落地）。
 *
 * @param world 目标世界（供条件求值与缺省 spawn 通道）
 * @param geometry 当前图的不可变地理数据
 * @param rules 实体演化规则（引擎按 rule.map 过滤）
 * @param fromTick 起始时刻（不含）
 * @param toTick 截止时刻（含）
 * @param deps 读/写依赖注入
 */
export function evolve(
  world: GameWorld,
  geometry: MapGeometry,
  rules: readonly EntityRule[],
  fromTick: number,
  toTick: number,
  deps: EvolutionDeps,
): void {
  if (toTick <= fromTick) return;

  const mapKey = geometry.key;
  const spawn = deps.spawn ?? createDefaultSpawn(world);
  const isOccupied = (x: number, y: number): boolean => deps.isOccupied(mapKey, x, y);

  // 本图规则预过滤：map 归属 → condition 一次性门控 → template 锚可满足性
  const cursors: RuleCursor[] = [];
  for (const rule of rules) {
    if (rule.map !== mapKey) continue;
    if (rule.condition !== undefined && !getSpawnCondition(rule.condition)(world)) continue;
    if (rule.mode === "template" && !rule.template.some((entry) => entry.kind === rule.kind)) {
      logger.warn("evolution: template rule anchor kind absent from template, rule unsatisfiable, skipped", {
        map: mapKey,
        rule: ruleIdentity(rule),
      });
      continue;
    }
    cursors.push({
      ctx: { geometry, mapKey, ruleId: ruleIdentity(rule), seed: deps.seed, spawn, isOccupied },
      rule,
      count: null,
      nextSlot: Math.floor(fromTick / rule.every) * rule.every + rule.every,
    });
  }

  // k 路合并：槽时刻升序、同槽按规则数组序（U2 等价性的根基，见文件头）
  for (;;) {
    let minSlot = Infinity;
    for (const cursor of cursors) {
      if (cursor.nextSlot <= toTick && cursor.nextSlot < minSlot) minSlot = cursor.nextSlot;
    }
    if (minSlot === Infinity) break;

    for (const cursor of cursors) {
      if (cursor.nextSlot !== minSlot) continue;
      if (cursor.count === null) {
        // 计数惰性到首个槽：反映同调用内更早槽/更前规则的本引擎产出
        cursor.count = deps.countByKind(mapKey, cursor.rule.region, cursor.rule.kind);
      }
      if (cursor.count >= cursor.rule.max) {
        cursor.nextSlot = Infinity; // 早退不变式：该规则剩余 timeSlot 全部跳过
        continue;
      }
      const need = cursor.rule.max - cursor.count;
      let added: number;
      switch (cursor.rule.mode) {
        case "density":
          added = spawnDensity(cursor.rule, need, cursor.ctx, minSlot);
          break;
        case "exact":
          added = spawnExact(cursor.rule, cursor.ctx, minSlot);
          break;
        case "template": {
          // 锚 kind 每组 anchorPerGroup 个 → 可补模板实例数向下取整（count 恒 ≤ max）
          const anchorPerGroup = cursor.rule.template.filter((entry) => entry.kind === cursor.rule.kind).length;
          added = spawnTemplate(cursor.rule, Math.floor(need / anchorPerGroup), cursor.ctx, minSlot);
          break;
        }
        default: {
          const exhaustive: never = cursor.rule;
          throw new Error(`Unhandled entity rule mode: ${String(exhaustive)}`);
        }
      }
      cursor.count += added;
      cursor.nextSlot += cursor.rule.every;
    }
  }
}
