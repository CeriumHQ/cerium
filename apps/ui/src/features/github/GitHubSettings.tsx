import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ExternalLink } from "lucide-react";

import { githubStatusAtom } from "../../backend/github.ts";

import { SettingsSection } from "../settings/parts.tsx";
import { GitHubSignIn } from "./GitHubSignIn.tsx";
import { GitHubMark } from "./parts.tsx";

/**
 * The machine's GitHub CLI, which the GitHub panel goes through: whether it's installed, its
 * version, who it's signed in as, and the way to sign in. `gh` keeps the credential.
 */
export function GitHubSection() {
  const result = useAtomValue(githubStatusAtom);
  const refresh = useAtomRefresh(githubStatusAtom);
  const status = AsyncResult.getOrElse(result, () => undefined);
  const accounts = status?._tag === "GhInstalled" ? status.accounts : [];
  const active = accounts.find((account) => account.active) ?? accounts[0];
  return (
    <SettingsSection
      title="GitHub"
      info={
        <>
          Pull requests and issues go through GitHub's own CLI, gh, on this computer. It keeps your sign-in;
          Cerium never reads it.
        </>
      }
    >
      <div className="flex gap-3.5 rounded-xl border border-line-subtle px-4 py-3.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line-subtle bg-surface-raised text-fg-primary">
          <GitHubMark size={16} {...(active === undefined ? { className: "opacity-35" } : {})} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-h-8 items-center gap-3">
            <span className="text-[13.5px] font-medium text-fg-primary">GitHub CLI</span>
            <span className="ml-auto text-xs">
              {status === undefined ? (
                <span className={AsyncResult.isFailure(result) ? "text-error" : "text-fg-tertiary"}>
                  {AsyncResult.isFailure(result) ? "Couldn't check" : "Checking…"}
                </span>
              ) : status._tag === "GhMissing" ? (
                <Dot tone="quiet">Not installed</Dot>
              ) : active === undefined ? (
                <Dot tone="attention">Not signed in</Dot>
              ) : active.failing === true ? (
                <Dot tone="attention">Sign-in stopped working</Dot>
              ) : (
                <Dot tone="success">Ready</Dot>
              )}
            </span>
          </div>
          {status?._tag === "GhMissing" ? (
            <a
              href={status.installUrl}
              target="_blank"
              rel="noreferrer"
              className="flex h-8 w-fit items-center gap-1.5 rounded-lg border border-line-subtle px-3 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
            >
              <ExternalLink size={13} strokeWidth={1.75} />
              Get GitHub CLI
            </a>
          ) : status?._tag === "GhInstalled" ? (
            <>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-fg-secondary">
                <span className="font-mono text-xs text-fg-primary tabular-nums">{status.version}</span>
                {status.versionStatus === "tooOld" ? (
                  <span className="text-error">· Too old for Cerium: update it to use GitHub here</span>
                ) : null}
                {accounts.map((account) => (
                  <span key={`${account.host}/${account.login}`} className="text-fg-tertiary">
                    · {account.login}
                    {account.host === "github.com" ? "" : ` on ${account.host}`}
                  </span>
                ))}
              </p>
              {active === undefined || active.failing === true ? <GitHubSignIn onSignedIn={refresh} /> : null}
            </>
          ) : null}
        </div>
      </div>
    </SettingsSection>
  );
}

function Dot({ tone, children }: { tone: "success" | "attention" | "quiet"; children: string }) {
  return (
    <span
      className={`flex items-center gap-1.5 ${tone === "attention" ? "text-attention" : tone === "success" ? "text-fg-secondary" : "text-fg-tertiary"}`}
    >
      <span
        className={`size-1.5 rounded-full ${tone === "success" ? "bg-success" : tone === "attention" ? "bg-attention" : "border border-fg-tertiary"}`}
      />
      {children}
    </span>
  );
}
