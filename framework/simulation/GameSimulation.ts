import { query, removeEntity } from "bitecs";
import { NetworkId, Velocity } from "components";
import { spawnEntity } from "framework/entities/spawn";
import { createGameInstance, type GameInstance } from "framework/bootstrap/GameInstance";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import { getCollisionDebugSnapshot } from "systems/core/collisionSystem";
import { recordTick } from "framework/metrics";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { ArchetypeRegistry } from "framework/entities/archetypeRegistry";
import type { EntityId, GameWorld } from "world";

import type { SimulationPort } from "./SimulationPort";
import type {
  PlayerInput, PlayerJoinResult, TickSnapshot, TickResult, DebugSnapshotOptions,
} from "./types";

export class GameSimulation implements SimulationPort {
  private instance: GameInstance;
  private world: GameWorld;
  private playerEidBySessionId = new Map<string, EntityId>();
  private lastSeqBySessionId = new Map<string, number>();
  private latestInputBySessionId = new Map<string, PlayerInput>();
  private netSyncFields: { component: string; fields: string[] }[];
  private componentRegistry: ComponentRegistry;

  constructor(gameDef: LoadedGameDefinition) {
    this.instance = createGameInstance(gameDef);
    this.world = this.instance.world;
    this.netSyncFields = gameDef.netSync?.fields ?? [];
    this.componentRegistry = this.world.components_registry as ComponentRegistry;
  }

  tick(dtMs: number): TickResult {
    const start = performance.now();
    this.applyInputs();
    this.instance.step(dtMs);
    const snapshot = this.buildSnapshot();
    const tickMs = performance.now() - start;
    recordTick(this.world.metrics, tickMs);
    if (tickMs > this.world.time.fixedDtMs * 1.5) {
      this.world.logger.warn("单帧耗时过高", {
        tick: this.world.time.tick,
        tickMs,
        fixedDtMs: this.world.time.fixedDtMs,
      });
    }
    return {
      snapshot,
      tickMs,
      tick: this.world.time.tick,
      avgTickMs: this.world.metrics.avgTickMs,
    };
  }

  addPlayer(sessionId: string): PlayerJoinResult {
    const playerSpawn = this.world.map?.spawns.player ?? { x: 0, y: 0 };
    const archetype = (this.world.archetypes as ArchetypeRegistry).get("player");
    const eid = spawnEntity(this.world, archetype, this.componentRegistry, {
      x: playerSpawn.x,
      y: playerSpawn.y,
    });
    this.playerEidBySessionId.set(sessionId, eid);
    return { networkId: NetworkId.value[eid] };
  }

  removePlayer(sessionId: string): void {
    const eid = this.playerEidBySessionId.get(sessionId);
    if (typeof eid === "number") {
      removeEntity(this.world, eid);
    }
    this.playerEidBySessionId.delete(sessionId);
    this.lastSeqBySessionId.delete(sessionId);
    this.latestInputBySessionId.delete(sessionId);
  }

  submitInput(sessionId: string, input: PlayerInput): void {
    const lastSeq = this.lastSeqBySessionId.get(sessionId) ?? 0;
    if (input.seq <= lastSeq) return;
    this.lastSeqBySessionId.set(sessionId, input.seq);
    this.latestInputBySessionId.set(sessionId, input);
  }

  getDebugSnapshot(options?: DebugSnapshotOptions): unknown {
    return getCollisionDebugSnapshot(this.world, options);
  }

  private applyInputs(): void {
    for (const [sessionId, input] of this.latestInputBySessionId) {
      const eid = this.playerEidBySessionId.get(sessionId);
      if (typeof eid !== "number") continue;
      Velocity.vx[eid] = input.moveX;
      Velocity.vy[eid] = input.moveY;
    }
  }

  private buildSnapshot(): TickSnapshot {
    const tick = this.world.time.tick;
    const entities = new Map<number, Record<string, number>>();

    if (this.netSyncFields.length === 0) return { tick, entities };

    const queryComponents: unknown[] = [NetworkId];
    for (const field of this.netSyncFields) {
      if (this.componentRegistry.has(field.component)) {
        queryComponents.push(this.componentRegistry.get(field.component));
      }
    }

    for (const eid of query(this.world, queryComponents)) {
      const id = NetworkId.value[eid];
      const values: Record<string, number> = {};
      for (const field of this.netSyncFields) {
        const comp = this.componentRegistry.get(field.component) as
          Record<string, unknown> | undefined;
        if (!comp) continue;
        for (const fname of field.fields) {
          const arr = (comp as Record<string, { [eid: number]: number }>)[fname];
          if (typeof arr === "object" && eid in arr) {
            values[`${field.component}.${fname}`] = arr[eid];
          }
        }
      }
      entities.set(id, values);
    }

    return { tick, entities };
  }
}

export function createGameSimulation(gameDef: LoadedGameDefinition): SimulationPort {
  return new GameSimulation(gameDef);
}
