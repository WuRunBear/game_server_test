import type { MapRuntime } from "map/types";

function xorshift32(state: number): () => number {
  let x = state | 0;
  return () => {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return x >>> 0;
  };
}

export interface SimpleGeneratorOptions {
  id: string;
  name: string;
  seed: number;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
}

export function generateSimpleMap(options: SimpleGeneratorOptions): MapRuntime {
  const rng = xorshift32(options.seed);
  const blocked = new Uint8Array(options.width * options.height);

  for (let y = 0; y < options.height; y++) {
    for (let x = 0; x < options.width; x++) {
      const isBorder = x === 0 || y === 0 || x === options.width - 1 || y === options.height - 1;
      blocked[y * options.width + x] = isBorder ? 1 : 0;
    }
  }

  const obstacleCount = Math.floor((options.width * options.height) * 0.05);
  for (let i = 0; i < obstacleCount; i++) {
    const x = 1 + (rng() % (options.width - 2));
    const y = 1 + (rng() % (options.height - 2));
    blocked[y * options.width + x] = 1;
  }

  const player = { x: options.tileWidth * 2, y: options.tileHeight * 2 };
  const npcs = [
    { kind: "villager", pos: { x: options.tileWidth * 4, y: options.tileHeight * 4 } },
  ];

  return {
    id: options.id,
    name: options.name,
    grid: {
      width: options.width,
      height: options.height,
      tileWidth: options.tileWidth,
      tileHeight: options.tileHeight,
    },
    blocked,
    spawns: { player, npcs },
    zones: [],
  };
}
