import { Room, type Client } from "@colyseus/core";

import { createGameSimulation, type SimulationPort } from "simulation";
import type { PlayerInput, TickSnapshot } from "simulation/types";
import { loadGameDefinition } from "framework/bootstrap/loadGameDefinition";
import { EntityState } from "network/colyseus/state/EntityState";
import { RoomState } from "network/colyseus/state/RoomState";
import { PlayerState } from "network/colyseus/state/PlayerState";

const DEBUG_COLLIDERS_PUSH_INTERVAL_MS = 500;

function isPlayerInput(message: unknown): message is PlayerInput {
  if (!message || typeof message !== "object") return false;
  const obj = message as Record<string, unknown>;
  return (
    typeof obj.seq === "number" &&
    typeof obj.moveX === "number" &&
    typeof obj.moveY === "number"
  );
}

export class GameRoom extends Room<{ state: RoomState }> {
  private sim!: SimulationPort;
  private debugSubscribers = new Set<string>();
  private debugMapSentSubscribers = new Set<string>();
  private debugPushCooldownMs = 0;

  onCreate(options?: Record<string, unknown>): void {
    this.autoDispose = false;

    const gameJsonPath = options?.gameJsonPath as string | undefined;
    const gameDef = loadGameDefinition({ gameJsonPath });
    const fixedDtMs = Math.max(1, Math.floor(1000 / gameDef.tickRate));

    this.sim = createGameSimulation(gameDef);
    this.state = new RoomState();

    this.setSimulationInterval((deltaTime) => this.onTick(deltaTime, fixedDtMs), fixedDtMs);

    this.onMessage("input", (client: Client, message: unknown) => {
      if (!isPlayerInput(message)) return;
      this.sim.submitInput(client.sessionId, message);
    });

    this.onMessage("debug_colliders_subscribe", (client: Client) => {
      this.debugSubscribers.add(client.sessionId);
      this.sendCollisionDebugSnapshot(client, true);
    });

    this.onMessage("debug_colliders_unsubscribe", (client: Client) => {
      this.debugSubscribers.delete(client.sessionId);
      this.debugMapSentSubscribers.delete(client.sessionId);
    });

    this.onMessage("debug_colliders_pull", (client: Client) => {
      this.sendCollisionDebugSnapshot(client);
    });
  }

  onJoin(client: Client): void {
    const { networkId } = this.sim.addPlayer(client.sessionId);

    const playerState = new PlayerState();
    playerState.sessionId = client.sessionId;
    playerState.entityId = networkId;
    this.state.players.set(client.sessionId, playerState);
  }

  onLeave(client: Client): void {
    this.sim.removePlayer(client.sessionId);

    this.debugSubscribers.delete(client.sessionId);
    this.debugMapSentSubscribers.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
  }

  getCollisionDebugSnapshot(options?: { includeMapBodies?: boolean }): unknown {
    return this.sim.getDebugSnapshot(options);
  }

  private onTick(deltaTimeMs: number, fixedDtMs: number): void {
    const result = this.sim.tick(deltaTimeMs || fixedDtMs);
    this.applySnapshot(result.snapshot);
    this.pushCollisionDebugSnapshots(deltaTimeMs || fixedDtMs);
  }

  private applySnapshot(snapshot: TickSnapshot): void {
    this.state.tick = snapshot.tick;
    const alive = new Set<number>();

    for (const [networkId, values] of snapshot.entities) {
      alive.add(networkId);
      const key = String(networkId);

      let entityState = this.state.entities.get(key);
      if (!entityState) {
        entityState = new EntityState();
        entityState.id = networkId;
        this.state.entities.set(key, entityState);
      }

      for (const [fieldKey, value] of Object.entries(values)) {
        entityState.values.set(fieldKey, value);
      }
    }

    this.state.entities.forEach((_value: EntityState, key: string) => {
      if (!alive.has(Number(key))) this.state.entities.delete(key);
    });
  }

  private pushCollisionDebugSnapshots(deltaTimeMs: number): void {
    if (this.debugSubscribers.size === 0) return;

    this.debugPushCooldownMs += deltaTimeMs;
    if (this.debugPushCooldownMs < DEBUG_COLLIDERS_PUSH_INTERVAL_MS) {
      return;
    }
    this.debugPushCooldownMs = 0;

    const snapshot = this.sim.getDebugSnapshot({ includeMapBodies: false });
    for (const client of this.clients) {
      if (!this.debugSubscribers.has(client.sessionId)) continue;
      client.send("debug_colliders_snapshot", snapshot);
    }
  }

  private sendCollisionDebugSnapshot(client: Client, forceIncludeMapBodies = false): void {
    const includeMapBodies =
      forceIncludeMapBodies || !this.debugMapSentSubscribers.has(client.sessionId);
    client.send(
      "debug_colliders_snapshot",
      this.sim.getDebugSnapshot({ includeMapBodies }),
    );
    if (includeMapBodies) {
      this.debugMapSentSubscribers.add(client.sessionId);
    }
  }
}
