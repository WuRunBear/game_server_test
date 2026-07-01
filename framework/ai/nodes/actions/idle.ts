import { State } from "mistreevous";

export function createIdleAction(_args?: Record<string, unknown>): () => State {
  return () => State.SUCCEEDED;
}
