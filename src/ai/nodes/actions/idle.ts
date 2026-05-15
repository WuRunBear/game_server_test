import { State } from "mistreevous";

export function createIdleAction(): () => State {
  return () => State.SUCCEEDED;
}
