export interface PlayerRecord {
  id: string;
  x: number;
  y: number;
  hp: number;
}

export interface Repository {
  savePlayer(record: PlayerRecord): Promise<void>;
  loadPlayer(id: string): Promise<PlayerRecord | null>;
}
