import { Button } from "@base-ui/react/button";
import { defaultSettings, type AccessMode, type ConnectedAssistant } from "@cerium/protocol";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { accountAtom, assistantsAtom, disconnectAssistant } from "../../backend/atoms.ts";
import { machineAtom } from "../../backend/machine.ts";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { accessLabel } from "../agents/model.ts";
import { copyText } from "../transcript/menus.ts";
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

// Assistants outside Cerium (Grok, ChatGPT, Claude and others) the user connects to their account
// as an MCP connector: whether the computer the window drives starts threads for them, and the
// access those threads get; the address to connect one at; and the ones connected, to disconnect.

/** Least access first, as the composer offers them. */
const ACCESS_MODES: ReadonlyArray<AccessMode> = ["readOnly", "ask", "acceptEdits", "auto", "fullAccess"];

/** The first backend that answers assistants (`RPC_VERSION` 43). */
const ASSISTANTS_RPC_VERSION = 43;

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Something went wrong. Try again.";

const when = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export function AssistantSettings({ onOpen }: { onOpen?: () => void }) {
  const result = useAtomValue(accountAtom);
  const account = AsyncResult.isSuccess(result) ? result.value : undefined;
  const machine = useAtomValue(machineAtom);
  const driven =
    machine === undefined || account?._tag !== "SignedIn"
      ? undefined
      : account.devices.find((device) => device.id === machine.id);

  return (
    <SettingsPage
      title="Assistants"
      description="Ask Grok, ChatGPT, Claude or another assistant to start threads here, through an MCP connector. Threads run on your computer, and you follow them in Cerium."
    >
      {account === undefined ? (
        <SettingsNote>Checking…</SettingsNote>
      ) : account._tag !== "SignedIn" ? (
        <SettingsNote>
          Assistants reach your computers through your Cerium account. Sign in first.{" "}
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              className="text-fg-secondary underline-offset-2 hover:underline"
            >
              Sign in
            </button>
          ) : null}
        </SettingsNote>
      ) : (
        <>
          {driven !== undefined && (driven.rpcVersion ?? 0) < ASSISTANTS_RPC_VERSION ? (
            <SettingsNote>Update Cerium on {driven.name} to let assistants start threads there.</SettingsNote>
          ) : (
            <SettingsSection title={machine === undefined ? "This computer" : machine.name}>
              <SettingsList>
                <AssistantRows />
              </SettingsList>
            </SettingsSection>
          )}
          <ConnectedSection />
        </>
      )}
    </SettingsPage>
  );
}

/** Whether the driven computer takes assistants' calls, and what access their threads start with. */
function AssistantRows() {
  const { value, saved, save, error } = useSetting("assistants", defaultSettings.assistants);
  return (
    <>
      <SettingsRow
        label="Let assistants start threads"
        hint="Connected assistants can start threads in your projects and message their agents while Cerium runs here."
        error={error}
        control={(labelledBy) => (
          <SettingsSwitch
            checked={value.enabled}
            onCheckedChange={(on) => save({ ...value, enabled: on })}
            disabled={saved === undefined}
            labelledBy={labelledBy}
          />
        )}
      />
      {value.enabled ? (
        <SettingsRow
          label="Access"
          hint="What the agents of an assistant's threads may do without asking you."
          className="pr-2.5"
          control={() => (
            <SelectRoot
              value={value.access}
              onValueChange={(next) => next !== null && save({ ...value, access: next as AccessMode })}
              disabled={saved === undefined}
            >
              <SelectTrigger label="Access of assistants' threads">{accessLabel[value.access]}</SelectTrigger>
              <SelectPopup>
                {ACCESS_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {accessLabel[mode]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </SelectRoot>
          )}
        />
      ) : null}
    </>
  );
}

/** The address to add an assistant at, and the ones the account has connected. */
function ConnectedSection() {
  const result = useAtomValue(assistantsAtom);
  const refresh = useAtomRefresh(assistantsAtom);
  const [copied, setCopied] = useState(false);

  if (AsyncResult.isFailure(result))
    return (
      <SettingsNote tone="error">
        Couldn't reach Cerium's cloud for your assistants.{" "}
        <button type="button" onClick={refresh} className="underline-offset-2 hover:underline">
          Try again
        </button>
      </SettingsNote>
    );
  if (!AsyncResult.isSuccess(result)) return <SettingsNote>Checking…</SettingsNote>;
  const { url, assistants } = result.value;

  return (
    <>
      <SettingsSection
        title="Connect an assistant"
        description="Add this address as a custom connector (an MCP server) in your assistant's settings, then sign in to Cerium when it asks."
      >
        <SettingsList>
          <div className="flex min-h-11 items-center gap-3 px-4 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-meta text-fg-primary">{url}</code>
            <Button
              aria-label="Copy the address"
              onClick={() => {
                copyText(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="flex h-7 items-center gap-1.5 rounded-md border border-line-subtle px-2.5 text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
            >
              {copied ? <Check size={13} strokeWidth={1.75} /> : <Copy size={13} strokeWidth={1.75} />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </SettingsList>
      </SettingsSection>
      <SettingsSection title="Connected">
        {assistants.length === 0 ? (
          <SettingsNote>No assistant is connected to your account.</SettingsNote>
        ) : (
          <SettingsList>
            {assistants.map((assistant) => (
              <AssistantRow key={assistant.id} assistant={assistant} onGone={refresh} />
            ))}
          </SettingsList>
        )}
      </SettingsSection>
    </>
  );
}

function AssistantRow({ assistant, onGone }: { assistant: ConnectedAssistant; onGone: () => void }) {
  const disconnect = useAtomSet(disconnectAssistant, { mode: "promise" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <SettingsRow
      label={assistant.name}
      hint={`${assistant.site} · connected ${when(assistant.connectedAt)}${
        assistant.lastUsedAt === undefined ? "" : ` · last used ${when(assistant.lastUsedAt)}`
      }`}
      error={error}
      control={() => (
        <RowButton
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(undefined);
            void disconnect({ payload: { id: assistant.id } }).then(
              () => onGone(),
              (failure: unknown) => {
                setBusy(false);
                setError(messageOf(failure));
              },
            );
          }}
        >
          {busy ? "Disconnecting…" : "Disconnect"}
        </RowButton>
      )}
    />
  );
}
