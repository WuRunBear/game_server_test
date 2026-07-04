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

  const mapPixelW = options.width * options.tileWidth;
  const mapPixelH = options.height * options.tileHeight;

  const player = { x: mapPixelW * 0.5, y: mapPixelH * 0.5 };
  const npcs = [
    { kind: "villager", pos: { x: mapPixelW * 0.5 + options.tileWidth * 2, y: mapPixelH * 0.5 }, zoneId: 1 },
  ];

  const zones = [{
    id: 1,
    name: "default",
    polygon: [
      { x: options.tileWidth, y: options.tileHeight },
      { x: mapPixelW - options.tileWidth, y: options.tileHeight },
      { x: mapPixelW - options.tileWidth, y: mapPixelH - options.tileHeight },
      { x: options.tileWidth, y: mapPixelH - options.tileHeight },
    ],
  }];

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
    zones,
  };
}
