export interface Vec2 {
  x: number;
  y: number;
}

export interface MapGrid {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
}

export interface MapZone {
  id: number;
  name: string;
  polygon: Vec2[];
}

export interface MapSpawns {
  player: Vec2 | null;
  npcs: Array<{ kind: string; pos: Vec2; zoneId?: number }>;
}

export interface MapRuntime {
  id: string;
  name: string;
  grid: MapGrid;
  blocked: Uint8Array;
  spawns: MapSpawns;
  zones: MapZone[];
}

export interface GeneratedMapSource {
  kind: "generated";
  generatorId: "simple";
  id: string;
  name: string;
  seed: number;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
}

export interface TiledMapSource {
  kind: "tiled";
  id: string;
  name: string;
  json: unknown;
}

export type MapSource = GeneratedMapSource | TiledMapSource;
