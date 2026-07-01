import { recordTick } from "framework/metrics";
import type { GameInstance } from "framework/bootstrap/GameInstance";

export interface HeadlessHostOptions {
  tickCount?: number;
  onTick?: (tick: number) => void;
}

export function runHeadless(
  instance: GameInstance,
  options?: HeadlessHostOptions,
): void {
  const maxTicks = options?.tickCount ?? 1;
  const onTick = options?.onTick;

  for (let i = 0; i < maxTicks; i++) {
    const start = performance.now();
    instance.step(instance.world.time.fixedDtMs);
    const tickMs = performance.now() - start;
    recordTick(instance.world.metrics, tickMs);
    onTick?.(instance.world.time.tick);
  }
}
