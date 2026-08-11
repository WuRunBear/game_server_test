/**
 * aiSystem：NPC 行为树驱动（tick 系统）。
 *
 * - 运行时机：拓扑序在 perceptionSystem 之后（先写黑板、AI 再消费），
 *   每 tick 对所有 [NPC] 实体步进行为树（mistreevous）。
 * - 建树：按实体 kind 对应的 archetype.behavior 惰性编译并缓存于
 *   world.systemRuntimes（跨 tick 复用）；kind 未注册原型或未配行为时
 *   回退默认树（防御：手工 spawn 的 NPC 不中断 tick）。
 * - 黑板（Blackboard）是感知与行为树间的共享内存：perceptionSystem 先写
 *   感知目标，BT 条件/动作读取；实体销毁后树与黑板在下一次扫描清理。
 *
 * 游戏无关——行为逻辑全部来自 game/behaviors/*.json 配置，本系统只负责执行。
 */
import { query } from "bitecs";
import { NPC, Kind } from "components";
import { createBlackboard, type Blackboard } from "ai/blackboard";
import { createNpcTree } from "ai/btFactory";
import { stepBehaviourTree, type BtInstance } from "ai/btRunner";
import type { EntityId, GameWorld } from "world";

/** AI 运行时缓存（挂 world.systemRuntimes，跨 tick 持久）。 */
type AiRuntime = {
  /** eid → 已编译行为树实例（每帧复用，避免重复建树） */
  npcTrees: Map<EntityId, BtInstance>;
  /** eid → 黑板（感知写入、行为树消费的共享状态） */
  blackboards: Map<EntityId, Blackboard>;
  /** eid → kind（建树查 archetype.behavior 用；setEntityKind 维护） */
  eidKind: Map<EntityId, string>;
};

const AI_KEY = "ai";

/** 取（或惰性创建）AI 运行时——世界级单例，首次 tick 时建空缓存。 */
function getRuntime(world: GameWorld): AiRuntime {
  let rt = world.systemRuntimes.get(AI_KEY) as AiRuntime | undefined;
  if (rt) return rt;

  rt = {
    npcTrees: new Map(),
    blackboards: new Map(),
    eidKind: new Map(),
  };
  world.systemRuntimes.set(AI_KEY, rt);
  return rt;
}

/**
 * 登记实体 kind：同步写运行时 eidKind 缓存与 Kind 组件（AoS，普通数组按 eid 索引）。
 * 由生成/注册路径调用；aiSystem 据此查实体行为树。
 */
export function setEntityKind(world: GameWorld, eid: EntityId, kind: string): void {
  const rt = getRuntime(world);
  rt.eidKind.set(eid, kind);
  Kind[eid] = kind;
}

/** 取实体黑板；不存在则创建（perceptionSystem 等先于 aiSystem 消费时用）。 */
export function getOrCreateBlackboard(world: GameWorld, eid: EntityId): Blackboard {
  const rt = getRuntime(world);
  let bb = rt.blackboards.get(eid);
  if (!bb) {
    bb = createBlackboard(eid);
    rt.blackboards.set(eid, bb);
  }
  return bb;
}

/**
 * aiSystem tick 体：对每个 [NPC] 实体步进行为树一次，并回收
 * 已销毁实体的树/黑板/kind 缓存（alive 集合比对，防泄漏）。
 */
export function aiSystem(world: GameWorld): GameWorld {
  const rt = getRuntime(world);
  const alive = new Set<EntityId>();

  for (const eid of query(world, [NPC])) {
    alive.add(eid);

    const bb = getOrCreateBlackboard(world, eid);

    let bt = rt.npcTrees.get(eid);
    if (!bt) {
      const kind = rt.eidKind.get(eid);
      // 防御：kind 可能未注册原型（如测试/工具手工 spawn 的 NPC），
      // 此时无行为树配置，回退默认树，不抛错中断 tick。
      if (kind && world.archetypes.has(kind)) {
        const archetype = world.archetypes.get(kind);
        if (archetype?.behavior) {
          const behaviorDef = world.gameDef.resolvedBehaviors.find((b) => b.id === archetype.behavior);
          if (behaviorDef) {
            bt = createNpcTree(behaviorDef.definition as Parameters<typeof createNpcTree>[0], world.actions);
          }
        }
      }

      if (!bt) {
        bt = createNpcTree(undefined, world.actions);
      }

      rt.npcTrees.set(eid, bt);
    }

    stepBehaviourTree(bt, { world, self: eid, bb });
  }

  // 回收：本帧未出现的实体已销毁，清理其树/黑板/kind 缓存
  for (const eid of rt.npcTrees.keys()) {
    if (!alive.has(eid)) {
      rt.npcTrees.delete(eid);
      rt.eidKind.delete(eid);
    }
  }
  for (const eid of rt.blackboards.keys()) {
    if (!alive.has(eid)) rt.blackboards.delete(eid);
  }

  return world;
}
