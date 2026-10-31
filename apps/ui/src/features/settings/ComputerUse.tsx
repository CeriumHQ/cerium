import { defaultComputerUse, type ComputerUseStatus, type ThreadId } from "@cerium/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState, type ReactNode } from "react";

import { threadsAtom } from "../../backend/atoms.ts";
import {
  computerUseAtom,
  computerUseOfferedAtom,
  installComputerUse,
  openComputerPermissions,
  stopComputerUse,
} from "../../backend/computerUse.ts";
import { messageOf } from "../terminal/model.ts";
import {
  SettingsList,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "./parts.tsx";
import { RowButton } from "./ToolRow.tsx";
import { useSetting } from "./useSetting.ts";

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/**
 * Computer use: agents of every harness see and operate the apps on the driven machine through
 * agent-desktop, which Cerium installs the first time it's turned on. Acting asks first unless an
 * agent runs on Auto or Full access; real pointer and keyboard input is a second switch.
 */
export function ComputerUseSettings() {
  const offered = useAtomValue(computerUseOfferedAtom);
  const status = AsyncResult.getOrElse(useAtomValue(computerUseAtom), () => undefined);
  const { value, saved, save, error } = useSetting("computerUse", defaultComputerUse);

  if (!offered) {
    return (
      <ComputerUsePage>
        <SettingsNote>Update Cerium on that computer to use computer use.</SettingsNote>
      </ComputerUsePage>
    );
  }
  const unsupported = status?.tool.state === "unsupported";

  return (
    <ComputerUsePage>
      <SettingsList>
        <SettingsRow
          label="Let agents use this computer"
          hint={
            unsupported
              ? status.tool.message
              : "They see your apps and act in them, asking first unless they run on Auto or Full access."
          }
          error={error}
          control={(labelledBy) => (
            <SettingsSwitch
              checked={value.enabled}
              onCheckedChange={(enabled) => save({ ...value, enabled })}
              disabled={saved === undefined || (unsupported && !value.enabled)}
              labelledBy={labelledBy}
            />
          )}
        />
        {value.enabled ? (
          <SettingsRow
            label="Mouse and keyboard"
            hint="Also move your pointer and type, which can get in your way. Off, they act through apps' accessibility only."
            control={(labelledBy) => (
              <SettingsSwitch
                checked={value.physicalInput}
                onCheckedChange={(physicalInput) => save({ ...value, physicalInput })}
                disabled={saved === undefined}
                labelledBy={labelledBy}
              />
            )}
          />
        ) : null}
        {value.enabled && status !== undefined && !unsupported ? <ToolRow status={status} /> : null}
        {value.enabled && status?.permission === "needed" ? <PermissionRow /> : null}
      </SettingsList>
      {status !== undefined && status.sessions.length > 0 ? <InUse status={status} /> : null}
    </ComputerUsePage>
  );
}

function ComputerUsePage({ children }: { children: ReactNode }) {
  return (
    <SettingsPage
      perMachine
      title="Computer use"
      description="Agents in any harness can see and use the apps on this computer, through the same accessibility features screen readers use."
    >
      {children}
    </SettingsPage>
  );
}

/** agent-desktop, the program that does the work: installing, ready, or why it isn't. */
function ToolRow({ status }: { readonly status: ComputerUseStatus }) {
  const install = useAtomSet(installComputerUse, { mode: "promise" });
  const [retrying, setRetrying] = useState(false);
  const { state, version, message } = status.tool;
  const retry = () => {
    setRetrying(true);
    install({ payload: undefined }).then(
      () => setRetrying(false),
      () => setRetrying(false),
    );
  };
  return (
    <SettingsRow
      label="agent-desktop"
      hint={
        state === "failed"
          ? undefined
          : state === "ready"
            ? `Version ${version}`
            : `Installing version ${version}…`
      }
      error={state === "failed" ? message : undefined}
      control={() =>
        state === "failed" ? (
          <RowButton tone="primary" onClick={retry} disabled={retrying}>
            {retrying ? "Installing…" : "Try again"}
          </RowButton>
        ) : (
          <span className="shrink-0 text-meta text-fg-tertiary">{state === "ready" ? "Ready" : null}</span>
        )
      }
    />
  );
}

/** The system's own permission, which the user grants outside Cerium (macOS Accessibility). */
function PermissionRow() {
  const open = useAtomSet(openComputerPermissions, { mode: "promise" });
  const [failed, setFailed] = useState<string>();
  return (
    <SettingsRow
      label={isMac ? "Accessibility permission" : "System permission"}
      hint={
        isMac
          ? "macOS needs it before Cerium can read and use other apps."
          : "Your system needs to allow Cerium to read and use other apps."
      }
      error={failed}
      control={() => (
        <RowButton
          tone="primary"
          onClick={() => {
            setFailed(undefined);
            open({ payload: undefined }).catch((cause: unknown) => setFailed(messageOf(cause)));
          }}
        >
          {isMac ? "Open System Settings" : "Grant"}
        </RowButton>
      )}
    />
  );
}

/** The agents using the computer now, a thread at a time, each with the way to stop it. */
function InUse({ status }: { readonly status: ComputerUseStatus }) {
  const threads = AsyncResult.getOrElse(useAtomValue(threadsAtom), () => []);
  const stop = useAtomSet(stopComputerUse, { mode: "promise" });
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const byThread = Map.groupBy(status.sessions, (session) => session.threadId);
  return (
    <SettingsSection title="In use now">
      <SettingsList>
        {[...byThread].map(([threadId, sessions]) => (
          <SettingsRow
            key={threadId}
            label={threads.find((overview) => overview.thread.id === threadId)?.thread.title ?? "A thread"}
            hint={sessions.map((session) => session.label).join(", ")}
            control={() => (
              <RowButton
                disabled={stopping.has(threadId)}
                onClick={() => {
                  setStopping((current) => new Set(current).add(threadId));
                  stop({ payload: { threadId: threadId as ThreadId } }).catch(() =>
                    setStopping((current) => {
                      const next = new Set(current);
                      next.delete(threadId);
                      return next;
                    }),
                  );
                }}
              >
                Stop
              </RowButton>
            )}
          />
        ))}
      </SettingsList>
    </SettingsSection>
  );
}
