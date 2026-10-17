import { Button } from "@base-ui/react/button";
import type { HarnessStatus, ProviderId } from "@cerium/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Check, Copy, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { harnessesAtom } from "../../backend/atoms.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { SettingsPage, SettingsSection } from "./parts.tsx";

const providers: ReadonlyArray<ProviderId> = ["claude", "codex", "muse", "cursor"];

/** Each provider's harness by the name its makers give it. */
const harnessName: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  muse: "Muse Code",
  cursor: "Cursor",
};

const authMethod: Record<string, string> = { "claude.ai": "a Claude account", apiKey: "an API key" };
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

type Installed = Extract<HarnessStatus, { _tag: "HarnessInstalled" }>;

export function HarnessSettings() {
  const result = useAtomValue(harnessesAtom);
  const refresh = useAtomRefresh(harnessesAtom);
  const statuses = AsyncResult.getOrElse(result, (): ReadonlyArray<HarnessStatus> => []);
  const checking = result.waiting;

  return (
    <SettingsPage
      title="Harnesses"
      description="The agent harnesses Cerium drives on this computer. Each keeps its own login: Cerium checks that you're signed in, and never sees your keys or tokens."
    >
      <SettingsSection
        title="On this computer"
        description="Cerium uses the versions you have installed and never bundles its own."
        action={
          <Button
            onClick={refresh}
            disabled={checking}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-subtle px-2.5 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:text-fg-tertiary"
          >
            <RefreshCw size={13} strokeWidth={1.75} className={checking ? "animate-spin" : ""} />
            {checking ? "Checking…" : "Check again"}
          </Button>
        }
      >
        <ul className="divide-y divide-line-subtle rounded-xl border border-line-subtle">
          {providers.map((provider) => (
            <li key={provider}>
              <HarnessRow
                provider={provider}
                status={statuses.find((status) => status.provider === provider)}
                {...(AsyncResult.isSuccess(result) ? {} : { unknown: true })}
              />
            </li>
          ))}
        </ul>
      </SettingsSection>
    </SettingsPage>
  );
}

function HarnessRow({
  provider,
  status,
  unknown = false,
}: {
  provider: ProviderId;
  /** Absent when Cerium has no adapter for the provider yet. */
  status: HarnessStatus | undefined;
  /** The backend hasn't answered, so nothing is known yet. */
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
            ) : (
              <State tone="success" dot>
                Ready
              </State>
            )}
          </span>
        </div>
        {status?._tag === "HarnessInstalled" ? <InstalledDetails status={status} /> : null}
        {status?._tag === "HarnessMissing" ? (
          <p className="text-[12.5px] leading-relaxed text-fg-secondary">
            <RichHint text={status.installHint} />
          </p>
        ) : null}
      </div>
    </div>
  );
}

function InstalledDetails({ status }: { status: Installed }) {
  const { auth } = status;
  return (
    <div className="flex flex-col gap-1.5 text-[12.5px]">
      <p className="flex flex-wrap items-center gap-x-2 text-fg-secondary">
        <span className="font-mono text-xs text-fg-primary tabular-nums">{status.version}</span>
        <span className="text-fg-disabled">·</span>
        {status.versionStatus === "supported" ? (
          <span className="text-fg-tertiary">Tested with Cerium</span>
        ) : status.versionStatus === "untested" ? (
          <span className="text-attention">Newer than Cerium has tested; it should still work</span>
        ) : (
          <span className="text-error">Too old for Cerium: update it to use it here</span>
        )}
        {auth._tag === "LoggedIn" && (auth.method || auth.plan) ? (
          <>
            <span className="text-fg-disabled">·</span>
            <span className="text-fg-tertiary">
              {auth.method ? `Signed in with ${authMethod[auth.method] ?? auth.method}` : "Signed in"}
              {auth.plan ? `, ${capitalized(auth.plan)} plan` : ""}
            </span>
          </>
        ) : null}
      </p>
      <p
        title={status.executablePath}
        className="truncate font-mono text-[11.5px] text-fg-tertiary select-text"
      >
        {status.executablePath}
      </p>
      {auth._tag === "LoggedOut" ? (
        <div className="mt-1 flex flex-col gap-1.5">
          <p className="text-fg-secondary">Log in with the harness's own command, then check again:</p>
          <Command text={auth.loginCommand} />
        </div>
      ) : null}
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

/** A command to run in a terminal, with a button that copies it. */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line-subtle bg-surface-window py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-primary select-text">{text}</code>
      <Button
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy command"}
        className="grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary"
      >
        {copied ? <Check size={13} strokeWidth={2.25} /> : <Copy size={13} strokeWidth={1.75} />}
      </Button>
    </div>
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
