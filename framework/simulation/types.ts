export interface PlayerInput {
  seq: number;
  moveX: number;
  moveY: number;
}

export interface PlayerJoinResult {
  networkId: number;
}

export interface TickSnapshot {
  tick: number;
  entities: Map<number, Record<string, number>>;
}

export interface TickResult {
  snapshot: TickSnapshot;
  tickMs: number;
  tick: number;
  avgTickMs: number;
}

export interface DebugSnapshotOptions {
  includeMapBodies?: boolean;
}
