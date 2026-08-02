import { query } from "bitecs";
import { NPC, Kind } from "components";
import { createBlackboard, type Blackboard } from "ai/blackboard";
import { createNpcTree } from "ai/btFactory";
import { stepBehaviourTree, type BtInstance } from "ai/btRunner";
import type { EntityId, GameWorld } from "world";

type AiRuntime = {
  npcTrees: Map<EntityId, BtInstance>;
  blackboards: Map<EntityId, Blackboard>;
  eidKind: Map<EntityId, string>;
};

const AI_KEY = "ai";

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

export function setEntityKind(world: GameWorld, eid: EntityId, kind: string): void {
  const rt = getRuntime(world);
  rt.eidKind.set(eid, kind);
  Kind[eid] = kind;
}

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
      const kind = rt.eidKind.get(eid);
      if (kind) {
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
