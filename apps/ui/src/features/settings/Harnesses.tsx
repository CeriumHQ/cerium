import { Button } from "@base-ui/react/button";
import {
  harnessName,
  OFFERED_PROVIDERS,
  type HarnessSetup,
  type HarnessStatus,
  type ProviderId,
} from "@cerium/protocol";
import { DISABLED_PROVIDERS_RPC_VERSION, type CommandTerminal, type HarnessCommand } from "@cerium/rpc";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Check, ChevronDown, Download, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { drivenRpcVersionAtom, harnessesAtom, loginAtom } from "../../backend/atoms.ts";
import { machineAtom } from "../../backend/machine.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { accessOptions } from "../composer/models.ts";
import {
  ActionDialog,
  CommandDialog,
  CommandTerminalView,
  CopyableCommand,
  useStartCommand,
} from "./ActionDialog.tsx";
import { useHarnessUpdates, type HarnessUpdate } from "./harnessUpdates.ts";
import { partitionHarnesses } from "./harnessModel.ts";
import { SettingsNote, SettingsPage, SettingsSection, SettingsSwitch } from "./parts.tsx";
import { useSetting } from "./useSetting.ts";
import { buttonClass } from "../../components/ui/Button.tsx";
import { InstalledMenu, RowButton, RowLink, ToolRow } from "./ToolRow.tsx";

export { harnessName };

type Installed = Extract<HarnessStatus, { _tag: "HarnessInstalled" }>;

/** A row's on/off switch: on while the harness is used, locked off while it can't be. */
interface Use {
  /** The user hasn't turned it off. */
  readonly on: boolean;
  /** The switch can be flipped: the setting has loaded and this machine's backend keeps it. */
  readonly changeable: boolean;
  readonly set: (on: boolean) => void;
}

/** The switch, locked off when the harness can't run whatever the user chose. */
const UseSwitch = ({ name, use, runnable }: { name: string; use: Use; runnable: boolean }) => (
  <SettingsSwitch
    label={`Use ${name}`}
    checked={runnable && use.on}
    onCheckedChange={use.set}
    disabled={!runnable || !use.changeable}
  />
);

/**
 * Each harness on the driven machine, with the account it runs on and the one thing to do about it. Check again reads them all afresh, and says when it last ran.
 */
export function HarnessSettings() {
  const result = useAtomValue(harnessesAtom);
  const refreshHarnesses = useAtomRefresh(harnessesAtom);
  const machine = useAtomValue(machineAtom)?.name;
  const keepsChoice = useAtomValue(drivenRpcVersionAtom) >= DISABLED_PROVIDERS_RPC_VERSION;
  const disabled = useSetting("disabledProviders", []);
  const useOf = (provider: ProviderId): Use => ({
    on: !disabled.value.includes(provider),
    changeable: keepsChoice && disabled.saved !== undefined,
    set: (on) =>
      disabled.save(
        on
          ? disabled.value.filter((each) => each !== provider)
          : [...disabled.value.filter((each) => each !== provider), provider],
      ),
  });
  const [checkedAt, setCheckedAt] = useState<number>();
  const checking = result.waiting;
  const check = () => {
    setCheckedAt(Date.now());
    refreshHarnesses();
  };
  const statuses = AsyncResult.getOrElse(result, (): ReadonlyArray<HarnessStatus> | undefined => undefined);
  const failed = AsyncResult.isFailure(result);
  const outdated = (statuses ?? []).filter(
    (status): status is Installed =>
      status._tag === "HarnessInstalled" &&
      status.auth._tag === "LoggedIn" &&
      !disabled.value.includes(status.provider) &&
      status.latestVersion !== undefined &&
      status.updateCommand !== undefined,
  );
  const groups =
    statuses === undefined ? undefined : partitionHarnesses(OFFERED_PROVIDERS, statuses, disabled.value);
  const renderList = (providers: ReadonlyArray<ProviderId>) => (
    <ul className="divide-y divide-line-subtle rounded-lg border border-line-subtle bg-surface-pane">
      {providers.map((provider) => (
        <li key={provider}>
          <HarnessRow
            provider={provider}
            status={statuses?.find((status) => status.provider === provider)}
            local={machine === undefined}
            onChanged={check}
            unknown={statuses === undefined}
            use={useOf(provider)}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <SettingsPage
      perMachine
      title="Harnesses"
      description="Each keeps its own login, and Cerium never reads its keys. Signing in and updating run its own command. A harness turned off isn't offered to threads or agents."
      action={
        <div className="flex items-center gap-3">
          {/* The last check, once finished, so a check that changed nothing still shows it ran. */}
          {checkedAt !== undefined && !checking && !failed ? (
            <span className="text-meta text-fg-tertiary tabular-nums max-sm:hidden">
              Checked {new Date(checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          ) : null}
          {outdated.length > 0 ? <UpdateAll targets={outdated} onChanged={check} /> : null}
          <Button onClick={check} disabled={checking} className={buttonClass({ size: "sm" })}>
            <RefreshCw size={13} strokeWidth={1.75} className={checking ? "animate-spin" : ""} />
            {checking ? "Checking…" : "Check again"}
          </Button>
        </div>
      }
    >
      {failed ? (
        <SettingsNote tone="error">
          {machine
            ? `Couldn't reach ${machine}. Check again once it's connected.`
            : "Couldn't check the harnesses. Try again in a moment."}
        </SettingsNote>
      ) : (
        <>
          {disabled.error ? <SettingsNote tone="error">{disabled.error}</SettingsNote> : null}
          {keepsChoice ? null : (
            <SettingsNote>Update Cerium on this machine to turn harnesses off.</SettingsNote>
          )}
          {groups === undefined ? (
            renderList(OFFERED_PROVIDERS)
          ) : (
            <>
              {groups.enabled.length > 0 ? (
                <SettingsSection
                  title={
                    <>
                      Enabled{" "}
                      <span className="font-normal text-fg-tertiary tabular-nums">
                        {groups.enabled.length}
                      </span>
                    </>
                  }
                >
                  {renderList(groups.enabled)}
                </SettingsSection>
              ) : null}
              {groups.disabled.length > 0 ? (
                <SettingsSection
                  title={
                    <>
                      Disabled{" "}
                      <span className="font-normal text-fg-tertiary tabular-nums">
                        {groups.disabled.length}
                      </span>
                    </>
                  }
                >
                  {renderList(groups.disabled)}
                </SettingsSection>
              ) : null}
            </>
          )}
        </>
      )}
    </SettingsPage>
  );
}

/**
 * Starts every harness with a newer release updating at once, each in its own row. Gone once each
 * one is updating or has updated.
 */
function UpdateAll({ targets, onChanged }: { targets: ReadonlyArray<Installed>; onChanged: () => void }) {
  const updates = useHarnessUpdates(onChanged);
  const waiting = targets.filter((target) => {
    const state = updates.of(target.provider)?.state;
    return state === undefined || state === "failed";
  });
  if (waiting.length === 0) return null;
  return (
    <Button
      onClick={() => {
        for (const target of waiting) updates.start(target.provider, target.version);
      }}
      className={buttonClass({ tone: "primary", size: "sm" })}
    >
      <Download size={13} strokeWidth={1.75} />
      {waiting.length === targets.length ? "Update all" : `Update ${waiting.length} more`}
    </Button>
  );
}

/** What the row's dialog shows, if anything: a browser sign-in, the setup step, or a running command. */
type Flow =
  | "browserSignIn"
  | "setup"
  | { readonly action: HarnessCommand; readonly started: Promise<CommandTerminal> }
  | undefined;

/** Where a missing harness is installed from: the first link in its install hint. */
export const installUrl = (status: Extract<HarnessStatus, { _tag: "HarnessMissing" }>): string | undefined =>
  /https:\/\/[^\s,]+/.exec(status.installHint)?.[0].replace(/[.;:)]+$/u, "");

/**
 * What an installed harness offers to do about itself, signing in and its one-time setup, and the
 * dialogs those open. Settings → Harnesses and the welcome lay them out each their own way; updating
 * happens in Settings' row itself (`useHarnessUpdates`).
 */
export function useHarnessFlows(status: Installed, onChanged: () => void) {
  const { provider, auth, setup } = status;
  const [flow, setFlow] = useState<Flow>();
  const startCommand = useStartCommand(provider);
  const run = (action: HarnessCommand) => setFlow({ action, started: startCommand(action) });
  const running = (action: HarnessCommand) =>
    typeof flow === "object" && flow.action === action ? flow.started : undefined;
  const name = harnessName[provider];
  const close = (open: boolean) => {
    if (!open) setFlow(undefined);
  };
  return {
    signIn: () =>
      auth._tag === "LoggedOut" && auth.browserLogin === true ? setFlow("browserSignIn") : run("login"),
    setUp: () => setFlow("setup"),
    dialogs: (
      <>
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
            description={`${name}'s own sign-in runs below. Follow its steps; ${name} keeps what it creates, and Cerium never reads it.`}
            command={auth._tag === "LoggedOut" ? auth.loginCommand : undefined}
            onFinished={onChanged}
          />
        )}
        {setup === undefined ? null : (
          <SetupDialog open={flow === "setup"} onOpenChange={close} status={status} setup={setup} />
        )}
      </>
    ),
  };
}

function HarnessRow({
  provider,
  status,
  local,
  onChanged,
  unknown = false,
  use,
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
  use: Use;
}) {
  const name = harnessName[provider];
  const mark = <ProviderLogo provider={provider} size={16} />;
  const locked = <UseSwitch name={name} use={use} runnable={false} />;

  if (unknown || status === undefined) {
    return (
      <ToolRow
        mark={mark}
        name={name}
        dim
        detail={unknown ? "Checking…" : "Not supported yet"}
        toggle={locked}
      />
    );
  }
  if (status._tag === "HarnessMissing") {
    const url = installUrl(status);
    return (
      <ToolRow
        mark={mark}
        name={name}
        dim
        detail="Not installed"
        toggle={locked}
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
  return <InstalledRow status={status} local={local} onChanged={onChanged} use={use} />;
}

function InstalledRow({
  status,
  local,
  onChanged,
  use,
}: {
  status: Installed;
  local: boolean;
  onChanged: () => void;
  use: Use;
}) {
  const { auth, setup, provider } = status;
  const flows = useHarnessFlows(status, onChanged);
  const updates = useHarnessUpdates(onChanged);
  const stored = updates.of(provider);
  // An update the harness has since reported past is done with.
  const update = stored?.state === "updated" && status.version !== stored.from ? undefined : stored;
  const [outputShown, setOutputShown] = useState(false);
  const newer = status.latestVersion;
  const signedOut = auth._tag === "LoggedOut";
  const version = (
    <span className="font-mono tabular-nums">
      {newer === undefined ? `v${status.version}` : `v${status.version} → v${newer}`}
    </span>
  );
  return (
    <>
      <ToolRow
        mark={<ProviderLogo provider={provider} size={16} />}
        name={harnessName[provider]}
        dim={signedOut || !use.on}
        tone={
          update?.state === "failed" || (update === undefined && use.on && (signedOut || setup))
            ? "attention"
            : "quiet"
        }
        toggle={<UseSwitch name={harnessName[provider]} use={use} runnable={!signedOut} />}
        detail={
          update?.state === "running" ? (
            <span className="inline-flex items-center gap-1.5">
              <RefreshCw size={11} strokeWidth={2} className="animate-spin" />
              {newer === undefined ? "Updating…" : `Updating to v${newer}…`}
            </span>
          ) : update?.state === "updated" ? (
            <span className="inline-flex items-center gap-1.5">
              <Check size={12} strokeWidth={2.25} className="text-success-text" />
              Updated
            </span>
          ) : update?.state === "failed" ? (
            "Update failed"
          ) : signedOut ? (
            "Not signed in"
          ) : setup ? (
            "Needs setup"
          ) : (
            version
          )
        }
        action={
          <>
            {update?.state === "running" || update?.state === "failed" ? (
              <>
                {update.failure === undefined ? (
                  <OutputToggle shown={outputShown} onToggle={() => setOutputShown(!outputShown)} />
                ) : null}
                {update.state === "running" ? (
                  <RowButton onClick={() => updates.stop(provider)}>Stop</RowButton>
                ) : (
                  <RowButton onClick={() => updates.start(provider, status.version)}>Try again</RowButton>
                )}
              </>
            ) : update === undefined && newer !== undefined && status.updateCommand !== undefined ? (
              <RowButton onClick={() => updates.start(provider, status.version)}>Update</RowButton>
            ) : null}
            {signedOut ? (
              <RowButton tone="primary" onClick={flows.signIn}>
                Sign in
              </RowButton>
            ) : setup ? (
              <RowButton tone="primary" onClick={flows.setUp}>
                Set up
              </RowButton>
            ) : null}
          </>
        }
        menu={
          <InstalledMenu version={status.version} newer={newer} path={status.executablePath} local={local} />
        }
      />
      {update === undefined || update.state === "updated" ? null : (
        <UpdateOutput
          update={update}
          shown={outputShown}
          command={status.updateCommand}
          onEnded={(code) => updates.ended(provider, update, code)}
        />
      )}
      {flows.dialogs}
    </>
  );
}

function OutputToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <Button
      onClick={onToggle}
      aria-label={shown ? "Hide output" : "Show output"}
      aria-expanded={shown}
      className="grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary aria-expanded:text-fg-primary"
    >
      <ChevronDown
        size={15}
        strokeWidth={1.75}
        className={`transition-transform duration-150 ease-out-soft ${shown ? "rotate-180" : ""}`}
      />
    </Button>
  );
}

/**
 * An update's command under its row: its terminal while the output is shown, or why it didn't start.
 * The terminal is followed while hidden too, to hear when the command ends.
 */
function UpdateOutput({
  update,
  shown,
  command,
  onEnded,
}: {
  update: HarnessUpdate;
  shown: boolean;
  command: string | undefined;
  onEnded: (code: number | undefined) => void;
}) {
  // Held with the run it came from, so a retry never hears the last run's terminal end.
  const [started, setStarted] = useState<{
    run: Promise<CommandTerminal>;
    terminal: CommandTerminal;
  }>();
  const terminal = started?.run === update.started ? started.terminal : undefined;
  useEffect(() => {
    let current = true;
    update.started.then(
      (each) => {
        if (current) setStarted({ run: update.started, terminal: each });
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [update.started]);

  if (update.failure !== undefined) {
    return (
      <div className="flex flex-col gap-2 px-4 pb-3 pl-14 text-meta">
        <p className="text-error-text">{update.failure}</p>
        {command === undefined ? null : (
          <>
            <p className="text-fg-secondary">Run this in a terminal instead, then check again:</p>
            <CopyableCommand text={command} />
          </>
        )}
      </div>
    );
  }
  if (terminal === undefined) return null;
  return (
    <div className={shown ? "px-4 pb-3" : "hidden"}>
      <div className="h-56 overflow-hidden rounded-lg border border-line-subtle bg-surface-window">
        <CommandTerminalView
          key={terminal.id}
          sessionKey={`${terminal.id}:${terminal.windowsBuild ?? ""}`}
          shown={shown}
          onEnded={onEnded}
        />
      </div>
    </div>
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
      <div className="flex flex-col gap-2 text-meta">
        <p className="text-fg-secondary">
          Run this once
          {setup.elevated ? " in a terminal opened as administrator" : " in a terminal"}, then check again:
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
      <div className="flex items-center gap-3 text-meta">
        <p className="min-w-0 flex-1 text-error-text">The sign-in didn't finish.</p>
        <RowButton onClick={retry}>Try again</RowButton>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line-subtle bg-surface-window py-2 pr-2 pl-3 text-meta">
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
