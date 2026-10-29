import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { accountAtom } from "../../backend/atoms.ts";
import { machineAtom } from "../../backend/machine.ts";
import { ACTIONS_VERSION } from "../terminal/model.ts";

/** Whether the machine the window drives has project actions and writes `.cerium.toml`: this computer always, another from `ACTIONS_VERSION`. */
export const useActionsOffered = (): boolean => {
  const machine = useAtomValue(machineAtom);
  const account = AsyncResult.getOrElse(useAtomValue(accountAtom), () => undefined);
  if (machine === undefined) return true;
  const device =
    account?._tag === "SignedIn" ? account.devices.find((each) => each.id === machine.id) : undefined;
  return (device?.rpcVersion ?? 0) >= ACTIONS_VERSION;
};
