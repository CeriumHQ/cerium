import { Button } from "@base-ui/react/button";
import { OFFERED_PROVIDERS, type HarnessSetup, type HarnessStatus, type ProviderId } from "@cerium/protocol";
import type { CommandTerminal, HarnessCommand } from "@cerium/rpc";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { harnessesAtom, loginAtom, modelsAtom } from "../../backend/atoms.ts";
import { machineAtom } from "../../backend/machine.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { InfoTip } from "../../components/ui/InfoTip.tsx";
import { accessOptions } from "../composer/models.ts";
import { GitHubSection } from "../github/GitHubSettings.tsx";
import { ActionDialog, CommandDialog, CopyableCommand, useStartCommand } from "./ActionDialog.tsx";
import { accountLabel } from "./harnessModel.ts";
import { SettingsPage, SettingsSection } from "./parts.tsx";
import { InstalledMenu, RowButton, RowLink, ToolRow } from "./ToolRow.tsx";

/** Each provider's harness by the name its makers give it. */
export const harnessName: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  muse: "Muse Code",
  cursor: "Cursor",
  opencode: "OpenCode",
};

type Installed = Extract<HarnessStatus, { _tag: "HarnessInstalled" }>;

export function HarnessSettings() {
  const result = useAtomValue(harnessesAtom);
  const refreshHarnesses = useAtomRefresh(harnessesAtom);
  const refreshModels = useAtomRefresh(modelsAtom);
  const driven = useAtomValue(machineAtom);
  // A harness just signed in or updated may offer different models too.
  const refresh = () => {
    refreshHarnesses();
    refreshModels();
  };
  return (
    <SettingsPage perMachine title="Harnesses">
      <HarnessesOnMachine result={result} machine={driven?.name} onCheck={refresh} />
      <GitHubSection />
    </SettingsPage>
  );
}

/**
 * Each harness on a machine, with the account it runs on and the one thing to do about it. Checking
 * belongs to the page; this shows what the check found, and says when it last ran.
 */
export function HarnessesOnMachine({
  result,
  machine,
  onCheck,
}: {
  result: AsyncResult.AsyncResult<ReadonlyArray<HarnessStatus>, unknown>;
  /** The machine's name when Cerium drives another one. */
  machine: string | undefined;
  onCheck: () => void;
}) {
  const [checkedAt, setCheckedAt] = useState<number>();
  const checking = result.waiting;
  const check = () => {
    setCheckedAt(Date.now());
    onCheck();
  };
  const statuses = AsyncResult.getOrElse(result, (): ReadonlyArray<HarnessStatus> | undefined => undefined);
  const failed = AsyncResult.isFailure(result);

  return (
    <SettingsSection
      title={machine ? `On ${machine}` : "On this computer"}
      description={
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          Each harness keeps its own login; Cerium never sees your keys.
          <InfoTip label="About the harnesses">
            Cerium drives the harnesses installed on this computer and never bundles their CLIs. Signing in
            and updating run each harness's own command. Cursor runs inside Cerium, through its own SDK, and
            updates with it.
          </InfoTip>
        </span>
      }
      action={
        <Button
          onClick={check}
          disabled={checking}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-subtle px-2.5 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:text-fg-tertiary"
        >
          <RefreshCw size={13} strokeWidth={1.75} className={checking ? "animate-spin" : ""} />
          {checking ? "Checking…" : "Check again"}
        </Button>
      }
    >
      {failed ? (
        <p className="rounded-xl border border-line-subtle px-4 py-3.5 text-[13px] text-error">
          {machine
            ? `Couldn't reach ${machine}. Check again once it's connected.`
            : "Couldn't check the harnesses. Try again in a moment."}
        </p>
      ) : (
        <ul className="divide-y divide-line-subtle rounded-xl border border-line-subtle">
          {OFFERED_PROVIDERS.map((provider) => (
            <li key={provider}>
              <HarnessRow
                provider={provider}
                status={statuses?.find((status) => status.provider === provider)}
                local={machine === undefined}
                onChanged={check}
                unknown={statuses === undefined}
              />
            </li>
          ))}
        </ul>
      )}
      {/* The result of the last check, once it has finished, so a check that changed nothing still shows it ran. */}
      {checkedAt !== undefined && !checking && !failed ? (
        <p className="text-right text-xs text-fg-tertiary tabular-nums">
          Checked {new Date(checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </p>
      ) : null}
    </SettingsSection>
  );
}

/** What the row's dialog shows, if anything: a browser sign-in, the setup step, or a running command. */
type Flow =
  | "browserSignIn"
  | "setup"
  | { readonly action: HarnessCommand; readonly started: Promise<CommandTerminal> }
  | undefined;

function HarnessRow({
  provider,
  status,
  local,
  onChanged,
  unknown = false,
}: {
  provider: ProviderId;
  /** Absent when Cerium has no adapter for the provider yet, or the machine hasn't answered. */
  status: HarnessStatus | undefined;
  /** The harness is on this computer, not one the window drives. */
  local: boolean;
  /** A sign-in or update ended: the harnesses are checked again. */
  onChanged: () => void;
  /** The machine hasn't answered yet, so nothing is known. */
  unknown?: boolean;
}) {
  const [flow, setFlow] = useState<Flow>();
  const startCommand = useStartCommand(provider);
  const run = (action: HarnessCommand) => setFlow({ action, started: startCommand(action) });
  const running = (action: HarnessCommand) =>
    typeof flow === "object" && flow.action === action ? flow.started : undefined;
  const name = harnessName[provider];
  const mark = <ProviderLogo provider={provider} size={16} />;

  if (unknown || status === undefined) {
    return <ToolRow mark={mark} name={name} dim detail={unknown ? "Checking…" : "Not supported yet"} />;
  }
  if (status._tag === "HarnessMissing") {
    const url = /https:\/\/[^\s,]+/.exec(status.installHint)?.[0].replace(/[.;:)]+$/u, "");
    return (
      <ToolRow
        mark={mark}
        name={name}
        dim
        detail="Not installed"
        action={
          url === undefined ? undefined : (
            <RowLink href={url}>
              Install
              <ExternalLink size={12} strokeWidth={1.75} className="ml-1.5 text-fg-tertiary" />
            </RowLink>
          )
        }
      />
    );
  }

  const { auth, setup } = status;
  const newer = status.latestVersion;
  const signedOut = auth._tag === "LoggedOut";
  const update =
    newer !== undefined && status.updateCommand !== undefined ? (
      <RowButton onClick={() => run("update")}>Update</RowButton>
    ) : null;
  const close = (open: boolean) => {
    if (!open) setFlow(undefined);
  };
  return (
    <>
      <ToolRow
        mark={mark}
        name={name}
        dim={signedOut}
        newer={newer}
        tone={signedOut || setup ? "attention" : "quiet"}
        detail={signedOut ? "Not signed in" : setup ? "Needs setup" : accountLabel(auth)}
        action={
          <>
            {update}
            {signedOut ? (
              <RowButton
                tone="primary"
                onClick={() => (auth.browserLogin === true ? setFlow("browserSignIn") : run("login"))}
              >
                Sign in
              </RowButton>
            ) : setup ? (
              <RowButton tone="primary" onClick={() => setFlow("setup")}>
                Set up
              </RowButton>
            ) : null}
          </>
        }
        menu={
          <InstalledMenu version={status.version} newer={newer} path={status.executablePath} local={local} />
        }
      />
      {auth._tag === "LoggedOut" && auth.browserLogin ? (
        <BrowserSignInDialog
          open={flow === "browserSignIn"}
          onOpenChange={close}
          provider={provider}
          onSignedIn={() => {
            setFlow(undefined);
            onChanged();
          }}
        />
      ) : (
        <CommandDialog
          started={running("login")}
          onClose={() => setFlow(undefined)}
          title={`Sign in to ${name}`}
          description={`${name}'s own sign-in runs below. Follow its steps; ${name} keeps what it creates, and Cerium never sees it.`}
          command={auth._tag === "LoggedOut" ? auth.loginCommand : undefined}
          onFinished={onChanged}
        />
      )}
      {status.updateCommand === undefined ? null : (
        <CommandDialog
          started={running("update")}
          onClose={() => setFlow(undefined)}
          title={`Update ${name}`}
          description={
            newer === undefined
              ? `${name} updates itself below.`
              : `${name} updates itself to ${newer} below.`
          }
          command={status.updateCommand}
          onFinished={onChanged}
        />
      )}
      {setup === undefined ? null : (
        <SetupDialog open={flow === "setup"} onOpenChange={close} status={status} setup={setup} />
      )}
    </>
  );
}

/** A one-time step the harness needs before some access modes can run commands, with its own command. */
function SetupDialog({
  open,
  onOpenChange,
  status,
  setup,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: Installed;
  setup: HarnessSetup;
}) {
  const name = harnessName[status.provider];
  const modes = accessOptions
    .filter((option) => setup.blocks.includes(option.value))
    .map((option) => option.label);
  const listed = modes.length > 1 ? `${modes.slice(0, -1).join(", ")} and ${modes.at(-1)}` : (modes[0] ?? "");
  const fullAccessWorks = !setup.blocks.includes("fullAccess");
  return (
    <ActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Set up ${name}'s ${setup.name}`}
      description={`Agents in ${listed} can't run commands until it's set up.${fullAccessWorks ? " Full access works without it." : ""} ${name} reports: ${setup.reason}.`}
    >
      <div className="flex flex-col gap-2 text-[12.5px]">
        <p className="text-fg-secondary">
          Run this once{setup.elevated ? " in a terminal opened as administrator" : " in a terminal"}, then
          check again:
        </p>
        <CopyableCommand text={setup.command} />
      </div>
    </ActionDialog>
  );
}

/**
 * The harness SDK's own sign-in page, in the browser. The SDK keeps the key the sign-in creates, so
 * all Cerium learns is that the sign-in finished.
 */
function BrowserSignInDialog({
  open,
  onOpenChange,
  provider,
  onSignedIn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderId;
  onSignedIn: () => void;
}) {
  const name = harnessName[provider];
  return (
    <ActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Sign in to ${name}`}
      description={`${name} signs in on its own page in your browser. The key it creates stays on this computer, where Cerium never reads it.`}
    >
      {open ? <SignInProgress provider={provider} onSignedIn={onSignedIn} /> : null}
    </ActionDialog>
  );
}

/** A running browser sign-in. Unmounting it lets go of the sign-in, which cancels it. */
function SignInProgress({ provider, onSignedIn }: { provider: ProviderId; onSignedIn: () => void }) {
  const result = useAtomValue(loginAtom(provider));
  const retry = useAtomRefresh(loginAtom(provider));
  const step = AsyncResult.isSuccess(result) ? result.value : undefined;
  const url = step?._tag === "OpenUrl" ? step.url : undefined;

  // The page opens by itself once the harness has it; the link below opens it again.
  useEffect(() => {
    if (url !== undefined) window.open(url, "_blank", "noopener,noreferrer");
  }, [url]);
  const signedIn = useEffectEvent(onSignedIn);
  useEffect(() => {
    if (step?._tag === "SignedIn") signedIn();
  }, [step]);

  if (AsyncResult.isFailure(result)) {
    return (
      <div className="flex items-center gap-3 text-[12.5px]">
        <p className="min-w-0 flex-1 text-error">The sign-in didn't finish.</p>
        <RowButton onClick={retry}>Try again</RowButton>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line-subtle bg-surface-window py-2 pr-2 pl-3 text-[12.5px]">
      <RefreshCw size={13} strokeWidth={1.75} className="shrink-0 animate-spin text-fg-tertiary" />
      <p className="min-w-0 flex-1 text-fg-secondary">
        {url === undefined
          ? "Starting the sign-in…"
          : step?._tag === "SignedIn"
            ? "Signed in. Checking again…"
            : "Waiting for the sign-in in your browser."}
      </p>
      {url === undefined ? null : <RowLink href={url}>Open it again</RowLink>}
    </div>
  );
}
