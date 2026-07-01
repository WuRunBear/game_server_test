export interface PlayerRecord {
  id: string;
  x: number;
  y: number;
  hp: number;
}

export interface MapInstanceRecord {
  id: string;
  source: string;
}

export interface Repository {
  savePlayer(record: PlayerRecord): Promise<void>;
  loadPlayer(id: string): Promise<PlayerRecord | null>;
  saveMapInstance(record: MapInstanceRecord): Promise<void>;
  loadMapInstance(id: string): Promise<MapInstanceRecord | null>;
}
