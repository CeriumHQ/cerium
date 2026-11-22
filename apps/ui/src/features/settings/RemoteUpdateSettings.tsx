import { REMOTE_UPDATES_RPC_VERSION, type UpdateCommand } from "@cerium/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Effect, Schedule, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { accountAtom, drivenRpcVersionAtom } from "../../backend/atoms.ts";
import { Backend, connectionAtom, connectionEpochAtom } from "../../backend/client.ts";
import { machineAtom, type DrivenMachine } from "../../backend/machine.ts";
import { SwitchComputerSheet } from "../account/SwitchComputerSheet.tsx";
import { messageOf } from "../terminal/model.ts";
import { channelLabel, offerVersion, statusText, versionLabel } from "../updates/model.ts";
import { SettingsList, SettingsNote, SettingsPage, SettingsRow } from "./parts.tsx";
import { RowButton } from "./ToolRow.tsx";

const runUpdate = Backend.mutation("RunDesktopUpdate");
const remoteUpdates = Atom.family((deviceId: DrivenMachine["id"]) =>
  Backend.runtime.atom((get) => {
    if (get(machineAtom)?.id !== deviceId || get(drivenRpcVersionAtom) < REMOTE_UPDATES_RPC_VERSION)
      return Stream.empty;
    get(connectionEpochAtom);
    return Stream.unwrap(
      Backend.use((client) => Effect.succeed(client("WatchDesktopUpdates", undefined))),
    ).pipe(Stream.retry(Schedule.spaced("2 seconds")));
  }),
);

export function RemoteUpdateSettings({ machine }: { machine: DrivenMachine }) {
  const supported = useAtomValue(drivenRpcVersionAtom) >= REMOTE_UPDATES_RPC_VERSION;
  const account = AsyncResult.getOrElse(useAtomValue(accountAtom), () => undefined);
  const [choosing, setChoosing] = useState(false);
  const canSwitch =
    account?._tag === "SignedIn" &&
    account.devices.some((device) => device.kind === "desktop" && device.id !== machine.id);
  const online = useAtomValue(connectionAtom) === "connected";

  return (
    <SettingsPage
      perMachine
      title="Updates"
      action={
        canSwitch ? <RowButton onClick={() => setChoosing(true)}>Switch computer</RowButton> : undefined
      }
    >
      {canSwitch && <SwitchComputerSheet open={choosing} onOpenChange={setChoosing} account={account} />}
      {!online ? (
        <SettingsNote>Waiting for {machine.name} to reconnect…</SettingsNote>
      ) : !supported ? (
        <SettingsNote>Update Cerium on {machine.name} once to enable updates from this device.</SettingsNote>
      ) : (
        <RemoteUpdateRow machine={machine} />
      )}
    </SettingsPage>
  );
}

function RemoteUpdateRow({ machine }: { machine: DrivenMachine }) {
  const result = useAtomValue(remoteUpdates(machine.id));
  const send = useAtomSet(runUpdate, { mode: "promise" });
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const run = (command: UpdateCommand) => {
    setSending(true);
    setError(undefined);
    void send({ payload: { deviceId: machine.id, command } })
      .catch((cause: unknown) => setError(messageOf(cause)))
      .finally(() => setSending(false));
  };
  if (!AsyncResult.isSuccess(result)) return <SettingsNote>Reading update status…</SettingsNote>;
  const updates = result.value;
  if (!updates || updates.status.kind === "unsupported")
    return <SettingsNote>This installation needs to be updated on {machine.name}.</SettingsNote>;
  const { status, restart } = updates;
  const version = offerVersion(status);
  const check = status.kind === "current" || status.kind === "unreachable";
  const apply =
    version !== undefined && !updates.manual && status.kind !== "installing" && restart !== "requested";
  let hint = statusText(updates);
  if (updates.manual && version !== undefined)
    hint = `${versionLabel(version)} is available. Install it on this Mac from the disk image.`;
  else if (status.kind === "downloading")
    hint = `Downloading ${versionLabel(status.version)} · ${Math.floor(status.percent)}%${restart === "requested" ? ". Cerium will restart when ready." : ""}`;
  else if (status.kind === "ready" && restart === "working")
    hint = "Agents are working. Tap Update and restart again when they finish.";
  return (
    <SettingsList>
      <SettingsRow
        label={`${versionLabel(updates.version)} · ${channelLabel[updates.buildChannel]}`}
        hint={<output>{hint}</output>}
        error={error}
        control={() =>
          check ? (
            <RowButton disabled={sending} onClick={() => run({ kind: "check" })}>
              Check now
            </RowButton>
          ) : apply && version !== undefined ? (
            <RowButton tone="primary" disabled={sending} onClick={() => run({ kind: "apply", version })}>
              Update and restart
            </RowButton>
          ) : null
        }
      />
    </SettingsList>
  );
}
