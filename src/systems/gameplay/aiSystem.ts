import { query } from "bitecs";

import { NPC } from "components";
import { createBlackboard, type Blackboard } from "ai/blackboard";
import { createNpcTree, type NpcBtAgent } from "ai/btFactory";
import { stepBehaviourTree, type BtInstance } from "ai/btRunner";
import type { EntityId, GameWorld } from "world";

/**
 * AI 系统运行期缓存。
 *
 * 每个 World 维护一份缓存，用于保存“实体 -> 行为树实例/黑板”的映射，避免每 tick 重新创建对象。
 */
type AiRuntime = {
  npcTrees: Map<EntityId, BtInstance<NpcBtAgent>>;
  blackboards: Map<EntityId, Blackboard>;
};

/**
 * 按 World 维度保存 AI 运行期缓存。
 *
 * 使用 WeakMap 确保 World 被释放时缓存可被 GC 回收，避免泄漏。
 */
const runtimeByWorld = new WeakMap<GameWorld, AiRuntime>();

/**
 * 获取或初始化指定 World 的 AI 运行期缓存。
 *
 * @param world ECS World
 * @returns 该 World 对应的运行期缓存
 */
function getRuntime(world: GameWorld): AiRuntime {
  const existing = runtimeByWorld.get(world);
  if (existing) return existing;

  const created: AiRuntime = {
    npcTrees: new Map(),
    blackboards: new Map(),
  };
  runtimeByWorld.set(world, created);
  return created;
}

/**
 * AI 系统：驱动所有 NPC 的行为树。
 *
 * 约定：
 * - 每个 NPC 实体拥有一份独立的黑板与行为树实例
 * - 每 tick 对每个 NPC 调用一次 step，向 agent 注入 { world, self, bb } 作为运行上下文
 * - 当 NPC 实体消失时，清理对应缓存
 *
 * @param world ECS World
 * @returns world
 */
export function aiSystem(world: GameWorld): GameWorld {
  const rt = getRuntime(world);
  const alive = new Set<EntityId>();

  for (const eid of query(world, [NPC])) {
    alive.add(eid);

    let bb = rt.blackboards.get(eid);
    if (!bb) {
      bb = createBlackboard(eid);
      rt.blackboards.set(eid, bb);
    }

    let bt = rt.npcTrees.get(eid);
    if (!bt) {
      bt = createNpcTree();
      rt.npcTrees.set(eid, bt);
    }

    stepBehaviourTree(bt, { world, self: eid, bb });
  }

  for (const eid of rt.npcTrees.keys()) {
    if (!alive.has(eid)) rt.npcTrees.delete(eid);
  }
  for (const eid of rt.blackboards.keys()) {
    if (!alive.has(eid)) rt.blackboards.delete(eid);
  }

  return world;
}
