import { Button } from "@base-ui/react/button";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Check, Copy, ExternalLink, LogIn, RefreshCw } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { githubLoginAtom } from "../../backend/github.ts";
import { InfoTip } from "../../components/ui/InfoTip.tsx";

let attempts = 0;

/**
 * Signs the machine's GitHub CLI in, through GitHub's own device page: `gh` shows a one-time code,
 * the page asks for it, and `gh` keeps the credential it gets. Cerium only learns that it worked.
 */
export function GitHubSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [attempt, setAttempt] = useState<number>();
  if (attempt !== undefined) {
    return (
      <SignInProgress
        attempt={attempt}
        onRetry={() => setAttempt(++attempts)}
        onCancel={() => setAttempt(undefined)}
        onSignedIn={() => {
          setAttempt(undefined);
          onSignedIn();
        }}
      />
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Button
        onClick={() => setAttempt(++attempts)}
        className="flex h-8 w-fit items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80"
      >
        <LogIn size={13} strokeWidth={2} />
        Sign in to GitHub
      </Button>
      <InfoTip label="About this sign-in">
        The GitHub CLI signs in on GitHub's own page and keeps its credential on this computer, where Cerium
        never reads it. You can revoke it in your GitHub settings under Applications.
      </InfoTip>
    </div>
  );
}

/** A running sign-in: the code to enter, and the page to enter it on. Unmounting it cancels it. */
function SignInProgress({
  attempt,
  onRetry,
  onCancel,
  onSignedIn,
}: {
  attempt: number;
  onRetry: () => void;
  onCancel: () => void;
  onSignedIn: () => void;
}) {
  const result = useAtomValue(githubLoginAtom(attempt));
  const step = AsyncResult.isSuccess(result) ? result.value : undefined;
  const code = step?._tag === "Code" ? step : undefined;
  const [copied, setCopied] = useState(false);

  const signedIn = useEffectEvent(onSignedIn);
  useEffect(() => {
    if (step?._tag === "SignedIn") signedIn();
  }, [step]);

  if (AsyncResult.isFailure(result)) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px]">
        <p className="min-w-0 flex-1 text-error">Sign-in didn't finish.</p>
        <QuietButton onClick={onRetry}>Try again</QuietButton>
        <QuietButton onClick={onCancel}>Cancel</QuietButton>
      </div>
    );
  }
  if (code === undefined) {
    return (
      <div className="flex items-center gap-2.5 text-[12.5px] text-fg-secondary">
        <RefreshCw size={13} strokeWidth={1.75} className="animate-spin text-fg-tertiary" />
        {step?._tag === "SignedIn" ? "Signed in. Checking again…" : "Starting the sign-in…"}
      </div>
    );
  }
  const copy = () => {
    void navigator.clipboard.writeText(code.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line-subtle bg-surface-window p-3.5 text-[12.5px]">
      <p className="text-fg-secondary">Enter this code on GitHub's page:</p>
      <div className="flex items-center gap-2">
        <code className="font-mono text-[18px] font-medium tracking-[0.12em] text-fg-primary select-all">
          {code.code}
        </code>
        <Button
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy code"}
          className="grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary"
        >
          {copied ? <Check size={14} strokeWidth={2.25} /> : <Copy size={14} strokeWidth={1.75} />}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={code.url}
          target="_blank"
          rel="noreferrer"
          onClick={copy}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 font-medium text-accent-fg transition-opacity hover:opacity-90"
        >
          <ExternalLink size={13} strokeWidth={2} />
          Copy and open GitHub
        </a>
        <QuietButton onClick={onCancel}>Cancel</QuietButton>
      </div>
      <p className="flex items-center gap-2 text-fg-tertiary">
        <RefreshCw size={12} strokeWidth={1.75} className="animate-spin" />
        Waiting for GitHub…
      </p>
    </div>
  );
}

function QuietButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <Button
      onClick={onClick}
      className="flex h-7 shrink-0 items-center rounded-md px-2 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
    >
      {children}
    </Button>
  );
}
