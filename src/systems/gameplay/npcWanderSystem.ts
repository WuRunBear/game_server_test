import { query } from "bitecs";

import { NPC, Velocity } from "components";
import type { EntityId, GameWorld } from "world";

type WanderState = {
  cooldownMs: number;
};

const runtimeByWorld = new WeakMap<GameWorld, Map<EntityId, WanderState>>();

function getRuntime(world: GameWorld) {
  let rt = runtimeByWorld.get(world);
  if (!rt) {
    rt = new Map();
    runtimeByWorld.set(world, rt);
  }
  return rt;
}

function randBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

export function npcWanderSystem(world: GameWorld): GameWorld {
  const rt = getRuntime(world);
  const alive = new Set<EntityId>();

  for (const eid of query(world, [NPC, Velocity])) {
    alive.add(eid);

    let st = rt.get(eid);
    if (!st) {
      st = { cooldownMs: 0 };
      rt.set(eid, st);
    }

    st.cooldownMs -= world.time.dtMs;
    if (st.cooldownMs > 0) continue;

    const speed = randBetween(30, 80);
    const angle = randBetween(0, Math.PI * 2);

    Velocity.vx[eid] = Math.cos(angle) * speed;
    Velocity.vy[eid] = Math.sin(angle) * speed;
    st.cooldownMs = randBetween(500, 1500);
  }

  for (const eid of rt.keys()) {
    if (!alive.has(eid)) rt.delete(eid);
  }

  return world;
}

