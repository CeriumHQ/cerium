import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { githubStatusAtom } from "../../backend/github.ts";
import { machineAtom } from "../../backend/machine.ts";
import { ActionDialog } from "../settings/ActionDialog.tsx";
import { SettingsSection } from "../settings/parts.tsx";
import { InstalledMenu, RowButton, RowLink, ToolRow } from "../settings/ToolRow.tsx";
import { GitHubSignInSteps, nextAttempt } from "./GitHubSignIn.tsx";
import { GitHubMark } from "./parts.tsx";

/** Where `gh`'s releases are; it updates through whatever installed it, so the page says how. */
const GH_RELEASES_URL = "https://github.com/cli/cli/releases/latest";

/**
 * The machine's GitHub CLI, which the GitHub panel goes through, in the harnesses' row: who it's
 * signed in as, and the way to sign in. `gh` keeps the credential.
 */
export function GitHubSection() {
  const result = useAtomValue(githubStatusAtom);
  const refresh = useAtomRefresh(githubStatusAtom);
  const local = useAtomValue(machineAtom) === undefined;
  const [attempt, setAttempt] = useState<number>();
  const status = AsyncResult.getOrElse(result, () => undefined);
  const accounts = status?._tag === "GhInstalled" ? status.accounts : [];
  const active = accounts.find((account) => account.active) ?? accounts[0];
  const mark = <GitHubMark size={16} />;

  const row =
    status === undefined ? (
      <ToolRow
        mark={mark}
        name="GitHub CLI"
        dim
        detail={AsyncResult.isFailure(result) ? "Couldn't check" : "Checking…"}
      />
    ) : status._tag === "GhMissing" ? (
      <ToolRow
        mark={mark}
        name="GitHub CLI"
        dim
        detail="Not installed"
        action={
          <RowLink href={status.installUrl}>
            Install
            <ExternalLink size={12} strokeWidth={1.75} className="ml-1.5 text-fg-tertiary" />
          </RowLink>
        }
      />
    ) : (
      <ToolRow
        mark={mark}
        name="GitHub CLI"
        dim={active === undefined}
        newer={status.latestVersion}
        tone={active === undefined || active.failing === true ? "attention" : "quiet"}
        detail={
          active === undefined
            ? "Not signed in"
            : active.failing === true
              ? `${active.login}'s sign-in stopped working`
              : active.host === "github.com"
                ? active.login
                : `${active.login} on ${active.host}`
        }
        action={
          <>
            {status.latestVersion === undefined ? null : <RowLink href={GH_RELEASES_URL}>Update</RowLink>}
            {active === undefined || active.failing === true ? (
              <RowButton tone="primary" onClick={() => setAttempt(nextAttempt())}>
                Sign in
              </RowButton>
            ) : null}
          </>
        }
        menu={
          <InstalledMenu
            version={status.version}
            newer={status.latestVersion}
            path={status.executablePath}
            local={local}
          />
        }
      />
    );

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
      <div className="rounded-xl border border-line-subtle">{row}</div>
      <ActionDialog
        open={attempt !== undefined}
        onOpenChange={(open) => {
          if (!open) setAttempt(undefined);
        }}
        title="Sign in to GitHub"
        description="The GitHub CLI signs in on GitHub's own page and keeps its credential on this computer, where Cerium never reads it."
      >
        {attempt === undefined ? null : (
          <GitHubSignInSteps
            attempt={attempt}
            onRetry={() => setAttempt(nextAttempt())}
            onSignedIn={() => {
              setAttempt(undefined);
              refresh();
            }}
          />
        )}
      </ActionDialog>
    </SettingsSection>
  );
}
