import type { SimulationPort } from "simulation/SimulationPort";
import type { TickResult } from "simulation/types";

export interface HeadlessHostOptions {
  tickCount?: number;
  dtMs?: number;
  onTick?: (result: TickResult) => void;
}

export function runHeadless(
  sim: SimulationPort,
  options?: HeadlessHostOptions,
): TickResult[] {
  const maxTicks = options?.tickCount ?? 1;
  const dtMs = options?.dtMs ?? 50;
  const onTick = options?.onTick;
  const results: TickResult[] = [];

  for (let i = 0; i < maxTicks; i++) {
    const result = sim.tick(dtMs);
    results.push(result);
    onTick?.(result);
  }

  return results;
}
