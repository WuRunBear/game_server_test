import type {
  PlayerInput, PlayerJoinResult, TickResult, DebugSnapshotOptions,
} from "./types";

export interface SimulationPort {
  tick(dtMs: number): TickResult;

  addPlayer(sessionId: string): PlayerJoinResult;

  removePlayer(sessionId: string): void;

  submitInput(sessionId: string, input: PlayerInput): void;

  getDebugSnapshot(options?: DebugSnapshotOptions): unknown;
}
