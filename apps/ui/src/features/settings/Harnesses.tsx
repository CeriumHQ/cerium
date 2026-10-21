import { Button } from "@base-ui/react/button";
import { OFFERED_PROVIDERS, type HarnessSetup, type HarnessStatus, type ProviderId } from "@cerium/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Check, Copy, ExternalLink, LogIn, RefreshCw } from "lucide-react";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";

import { harnessesAtom, loginAtom, modelsAtom } from "../../backend/atoms.ts";
import { machineAtom } from "../../backend/machine.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { InfoTip } from "../../components/ui/InfoTip.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { accessOptions } from "../composer/models.ts";
import { GitHubSection } from "../github/GitHubSettings.tsx";
import { SettingsPage, SettingsSection } from "./parts.tsx";

/** Each provider's harness by the name its makers give it. */
export const harnessName: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  muse: "Muse Code",
  cursor: "Cursor",
  opencode: "OpenCode",
};

/**
 * How each harness reports its sign-in, as people say it. OpenCode names its connected providers
 * themselves ("Anthropic, OpenAI"), which read as they are.
 */
const authMethod: Record<string, string> = {
  "claude.ai": "Claude account",
  chatgpt: "ChatGPT account",
  "meta.ai": "Meta account",
  cursorLogin: "Cursor account",
  apiKey: "API key",
  opencodeFree: "Free models",
};
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

type Installed = Extract<HarnessStatus, { _tag: "HarnessInstalled" }>;

export function HarnessSettings() {
  const result = useAtomValue(harnessesAtom);
  const refreshHarnesses = useAtomRefresh(harnessesAtom);
  const refreshModels = useAtomRefresh(modelsAtom);
  const driven = useAtomValue(machineAtom);
  // A harness just logged in or updated may offer different models too.
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
 * Each harness on a machine, with its state and the fix for it. Checking belongs to the page; this
 * shows what the check found, and says when it last ran.
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
            Cerium drives the harnesses installed on this computer and never bundles their CLIs. Cursor runs
            inside Cerium, through its own SDK.
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
                onSignedIn={check}
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

function HarnessRow({
  provider,
  status,
  onSignedIn,
  unknown = false,
}: {
  provider: ProviderId;
  /** Absent when Cerium has no adapter for the provider yet, or the machine hasn't answered. */
  status: HarnessStatus | undefined;
  onSignedIn: () => void;
  /** The machine hasn't answered yet, so nothing is known. */
  unknown?: boolean;
}) {
  const ready = status?._tag === "HarnessInstalled" && status.auth._tag === "LoggedIn";
  return (
    <div className="flex gap-3.5 px-4 py-3.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line-subtle bg-surface-raised text-fg-primary">
        <ProviderLogo
          provider={provider}
          size={16}
          {...(ready ? {} : { className: "opacity-35 grayscale" })}
        />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-h-8 items-center gap-3">
          <span className={`text-[13.5px] font-medium ${status ? "text-fg-primary" : "text-fg-tertiary"}`}>
            {harnessName[provider]}
          </span>
          <span className="ml-auto">
            {unknown ? (
              <State tone="quiet">Checking…</State>
            ) : status === undefined ? (
              <State tone="quiet">Not supported yet</State>
            ) : status._tag === "HarnessMissing" ? (
              <State tone="quiet" dot>
                Not installed
              </State>
            ) : status.auth._tag === "LoggedOut" ? (
              <State tone="attention" dot>
                Not logged in
              </State>
            ) : status.setup ? (
              <State tone="attention" dot>
                Needs setup
                <InfoTip label="Why setup is needed">
                  {harnessName[provider]} reports: {status.setup.reason}.
                </InfoTip>
              </State>
            ) : (
              <State tone="success" dot>
                Ready
              </State>
            )}
          </span>
        </div>
        {status?._tag === "HarnessInstalled" ? (
          <InstalledDetails status={status} onSignedIn={onSignedIn} />
        ) : null}
        {status?._tag === "HarnessMissing" ? (
          <InstallSteps provider={provider} hint={status.installHint} />
        ) : null}
      </div>
    </div>
  );
}

function InstalledDetails({ status, onSignedIn }: { status: Installed; onSignedIn: () => void }) {
  const { auth } = status;
  // The account in words, as the harness reports it, and the plan when there is one.
  const account =
    auth._tag === "LoggedIn"
      ? [
          auth.method ? (authMethod[auth.method] ?? auth.method) : undefined,
          auth.plan ? `${capitalized(auth.plan)} plan` : undefined,
        ]
          .filter((part) => part !== undefined)
          .join(" · ")
      : "";
  return (
    <div className="flex flex-col gap-1.5 text-[12.5px]">
      {/* Each detail carries its own dot, so a line that wraps never ends on one. */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-fg-secondary">
        <span className="font-mono text-xs text-fg-primary tabular-nums">{status.version}</span>
        {status.versionStatus === "untested" ? (
          <span className="flex items-center gap-2 text-fg-tertiary">
            <Dot />
            Not tested with Cerium
            <InfoTip label="About this version">Newer than Cerium has tested. It should still work.</InfoTip>
          </span>
        ) : status.versionStatus === "tooOld" ? (
          <span className="flex items-center gap-2 text-error">
            <Dot />
            Too old for Cerium: update it to use it here
          </span>
        ) : null}
        {account ? (
          <span className="flex items-center gap-2 text-fg-tertiary">
            <Dot />
            {account}
          </span>
        ) : null}
      </p>
      <PathLine path={status.executablePath} />
      {auth._tag === "LoggedOut" && auth.loginCommand ? (
        <div className="mt-1 flex flex-col gap-1.5">
          <p className="text-fg-secondary">Run this in a terminal, then check again:</p>
          <Command text={auth.loginCommand} />
        </div>
      ) : null}
      {auth._tag === "LoggedOut" && auth.browserLogin ? (
        <BrowserSignIn provider={status.provider} onSignedIn={onSignedIn} />
      ) : null}
      {auth._tag === "LoggedIn" && status.setup ? (
        <SetupNeeded provider={status.provider} setup={status.setup} />
      ) : null}
    </div>
  );
}

function Dot() {
  return (
    <span aria-hidden="true" className="text-fg-disabled">
      ·
    </span>
  );
}

/**
 * The install path, cut short in the row. Its full text shows on hover, and a button copies it.
 */
function PathLine({ path }: { path: string }) {
  // The folders give way to the ellipsis first, so the program's own name stays in view.
  const folder = /^.*[\\/]/.exec(path)?.[0] ?? "";
  const file = path.slice(folder.length);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Tooltip
        label={<span className="max-w-[min(32rem,80vw)] font-mono text-[11.5px] break-all">{path}</span>}
        side="bottom"
      >
        <code className="flex min-w-0 font-mono text-[11.5px] text-fg-tertiary select-text">
          <span className="min-w-0 truncate">{folder}</span>
          <span className="shrink-0">{file}</span>
        </code>
      </Tooltip>
      <CopyButton text={path} label="Copy path" />
    </div>
  );
}

/**
 * A missing harness's install hint, split into the download and the sign-in command so each is one
 * click away. A hint that doesn't have that shape is shown as written.
 */
function InstallSteps({ provider, hint }: { provider: ProviderId; hint: string }) {
  // The hint ends its sentence after the address, not as part of it.
  const url = /https:\/\/[^\s,]+/.exec(hint)?.[0].replace(/[.;:)]+$/u, "");
  const command = /`([^`]+)`/.exec(hint)?.[1];
  if (url === undefined || command === undefined) {
    return (
      <p className="text-[12.5px] leading-relaxed text-fg-secondary">
        <RichHint text={hint} />
      </p>
    );
  }
  return (
    <div className="mt-1 flex flex-col items-start gap-2 text-[12.5px]">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="flex h-8 items-center gap-1.5 rounded-lg border border-line-subtle px-3 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
      >
        <ExternalLink size={13} strokeWidth={1.75} />
        Get {harnessName[provider]}
      </a>
      <p className="text-fg-secondary">
        {/\b(?:login|auth)\b/u.test(command) ? "Then sign in from a terminal:" : "Then run in a terminal:"}
      </p>
      <div className="w-full">
        <Command text={command} />
      </div>
    </div>
  );
}

/** A one-time step the harness needs before some access modes can run commands, with its own command. */
function SetupNeeded({ provider, setup }: { provider: ProviderId; setup: HarnessSetup }) {
  const modes = accessOptions
    .filter((option) => setup.blocks.includes(option.value))
    .map((option) => option.label);
  const listed = modes.length > 1 ? `${modes.slice(0, -1).join(", ")} and ${modes.at(-1)}` : (modes[0] ?? "");
  const fullAccessWorks = !setup.blocks.includes("fullAccess");
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      <p className="leading-relaxed text-fg-secondary">
        Agents in {listed} can't run commands until {harnessName[provider]}'s {setup.name} is set up.
        {fullAccessWorks ? " Full access works without it." : ""}
      </p>
      <Command text={setup.command} />
      <p className="text-fg-tertiary">
        Run it once{setup.elevated ? " in a terminal opened as administrator" : " in a terminal"}, then check
        again.
      </p>
    </div>
  );
}

function State({
  tone,
  dot = false,
  children,
}: {
  tone: "success" | "attention" | "quiet";
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`flex items-center gap-1.5 text-xs ${
        tone === "attention"
          ? "text-attention"
          : tone === "success"
            ? "text-fg-secondary"
            : "text-fg-tertiary"
      }`}
    >
      {dot ? (
        <span
          className={`size-1.5 rounded-full ${
            tone === "success"
              ? "bg-success"
              : tone === "attention"
                ? "bg-attention"
                : "border border-fg-tertiary"
          }`}
        />
      ) : null}
      {children}
    </span>
  );
}

/**
 * Starts the harness SDK's own sign-in page in the browser. The SDK keeps the key the sign-in creates,
 * so all Cerium learns is that the sign-in finished.
 */
function BrowserSignIn({ provider, onSignedIn }: { provider: ProviderId; onSignedIn: () => void }) {
  const [signingIn, setSigningIn] = useState(false);
  if (signingIn) {
    return (
      <SignInProgress
        provider={provider}
        onCancel={() => setSigningIn(false)}
        onSignedIn={() => {
          setSigningIn(false);
          onSignedIn();
        }}
      />
    );
  }
  return (
    <div className="mt-1 flex items-center gap-2">
      <Button
        onClick={() => setSigningIn(true)}
        className="flex h-8 w-fit items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80"
      >
        <LogIn size={13} strokeWidth={2} />
        Sign in with {harnessName[provider]}
      </Button>
      <InfoTip label="About this sign-in">
        {harnessName[provider]} signs in on its own page. The key it creates stays on this computer, where
        Cerium never reads it. You can revoke it from your {harnessName[provider]} dashboard.
      </InfoTip>
    </div>
  );
}

/** A running sign-in. Unmounting it lets go of the sign-in, which cancels it. */
function SignInProgress({
  provider,
  onCancel,
  onSignedIn,
}: {
  provider: ProviderId;
  onCancel: () => void;
  onSignedIn: () => void;
}) {
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
      <div className="mt-1 flex items-center gap-3">
        <p className="min-w-0 flex-1 text-error">Sign-in didn't finish.</p>
        <QuietButton onClick={retry}>Try again</QuietButton>
        <QuietButton onClick={onCancel}>Cancel</QuietButton>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-3 rounded-lg border border-line-subtle bg-surface-window py-1.5 pr-1.5 pl-3">
      <RefreshCw size={13} strokeWidth={1.75} className="shrink-0 animate-spin text-fg-tertiary" />
      <p className="min-w-0 flex-1 text-fg-secondary">
        {url === undefined
          ? "Starting the sign-in…"
          : step?._tag === "SignedIn"
            ? "Signed in. Checking again…"
            : "Waiting for the sign-in in your browser."}
      </p>
      {url !== undefined ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
        >
          <ExternalLink size={12} strokeWidth={1.75} />
          Open it again
        </a>
      ) : null}
      <QuietButton onClick={onCancel}>Cancel</QuietButton>
    </div>
  );
}

function QuietButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button
      onClick={onClick}
      className="flex h-7 shrink-0 items-center rounded-md px-2 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
    >
      {children}
    </Button>
  );
}

/** A command to run in a terminal, with a button that copies it. */
function Command({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line-subtle bg-surface-window py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-primary select-text">{text}</code>
      <CopyButton text={text} label="Copy command" />
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <Button
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      className="grid size-6 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary"
    >
      {copied ? <Check size={13} strokeWidth={2.25} /> : <Copy size={13} strokeWidth={1.75} />}
    </Button>
  );
}

/** A harness's plain-text hint, with its `code` and links made usable. */
function RichHint({ text }: { text: string }) {
  return text.split(/(`[^`]+`|https:\/\/[^\s,]+)/).map((part, index) =>
    part.startsWith("`") ? (
      <code key={index} className="rounded bg-surface-hover px-1 font-mono text-[11.5px] text-fg-primary">
        {part.slice(1, -1)}
      </code>
    ) : part.startsWith("https://") ? (
      <a
        key={index}
        href={part}
        target="_blank"
        rel="noreferrer"
        className="text-fg-primary underline decoration-fg-tertiary underline-offset-2 hover:decoration-fg-primary"
      >
        {part.replace(/^https:\/\//, "")}
      </a>
    ) : (
      part
    ),
  );
}
