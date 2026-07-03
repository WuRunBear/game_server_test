import { query } from "bitecs";

import { NPC } from "components";
import { createBlackboard, type Blackboard } from "ai/blackboard";
import { createNpcTree } from "ai/btFactory";
import { stepBehaviourTree, type BtInstance } from "ai/btRunner";
import type { EntityId, GameWorld } from "world";

type AiRuntime = {
  npcTrees: Map<EntityId, BtInstance>;
  blackboards: Map<EntityId, Blackboard>;
};

const AI_KEY = "ai";

function getRuntime(world: GameWorld): AiRuntime {
  let rt = world.systemRuntimes.get(AI_KEY) as AiRuntime | undefined;
  if (rt) return rt;

  rt = {
    npcTrees: new Map(),
    blackboards: new Map(),
  };
  world.systemRuntimes.set(AI_KEY, rt);
  return rt;
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
