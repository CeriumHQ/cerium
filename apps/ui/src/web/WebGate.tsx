import { Button } from "@base-ui/react/button";
import type { AccountState } from "@cerium/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { LogIn, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useLaunched } from "../app/launch.ts";
import { accountAtom, cancelSignIn, signIn } from "../backend/atoms.ts";
import { openSignIn } from "../backend/signIn.ts";
import { WEB } from "../backend/target.ts";
import { CeriumMark } from "../components/CeriumMark.tsx";
import { InfoTip } from "../components/ui/InfoTip.tsx";
import { thisDevice } from "../features/account/model.ts";

// What the web client shows before it may drive anything: signing in, and connecting to the account
// for the first time. Signed out it has nothing to show.

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Something went wrong. Try again.";

/** The web client's window once the relay has answered for this device; until then, the way there. */
export function WebGate({ children }: { children: ReactNode }) {
  const result = useAtomValue(accountAtom);
  const account = AsyncResult.isSuccess(result) ? result.value : undefined;
  const admitted = account?._tag === "SignedIn" && thisDevice(account) !== undefined;
  // Signing in shows once the account is known; past it, the window says when it's ready.
  useLaunched(WEB && account !== undefined && !admitted);
  if (!WEB || admitted) return children;
  return (
    <main className="flex h-full flex-col items-center justify-center overflow-y-auto bg-surface-window px-6 pt-[max(env(safe-area-inset-top),2rem)] pb-[max(env(safe-area-inset-bottom),2rem)]">
      <div className="flex w-full max-w-sm flex-col gap-7">
        <div className="flex items-center gap-2.5 text-fg-primary">
          <CeriumMark size={22} landing />
          <span className="text-title font-semibold tracking-tight">Cerium</span>
        </div>
        {account === undefined ? null : account._tag === "SignedIn" ? (
          <Connecting connection={account.connection} />
        ) : (
          <SigningIn account={account} />
        )}
      </div>
    </main>
  );
}

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-balance text-fg-primary">
        {title}
      </h1>
      <p className="text-reading leading-relaxed text-fg-secondary">{children}</p>
    </div>
  );
}

const primary =
  "flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-reading font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80 disabled:opacity-60";
const quiet =
  "flex h-10 w-full items-center justify-center rounded-xl px-4 text-reading text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary";

/** Signed out, or waiting on Cerium's sign-in page. */
function SigningIn({ account }: { account: Exclude<AccountState, { _tag: "SignedIn" }> }) {
  const start = useAtomSet(signIn, { mode: "promise" });
  const cancel = useAtomSet(cancelSignIn, { mode: "promise" });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();

  const begin = () => {
    setStarting(true);
    setError(undefined);
    void start({ payload: undefined }).then(
      ({ url }) => openSignIn(url),
      (failure: unknown) => {
        setStarting(false);
        setError(messageOf(failure));
      },
    );
  };

  if (account._tag === "SigningIn") {
    return (
      <>
        <Heading title="Finish signing in">
          This device joins your account once you finish on Cerium's page.
        </Heading>
        <div className="flex flex-col gap-2">
          <Button onClick={() => openSignIn(account.url)} className={primary}>
            <LogIn size={15} strokeWidth={2} />
            Continue signing in
          </Button>
          <Button onClick={() => void cancel({ payload: undefined })} className={quiet}>
            Cancel
          </Button>
        </div>
      </>
    );
  }

  const shownError = error ?? account.error;
  return (
    <>
      <Heading title="Reach your computers from here">
        See and continue the threads on all your computers from this device.
      </Heading>
      <div className="flex flex-col gap-3">
        <Button onClick={begin} disabled={starting} className={primary}>
          <LogIn size={15} strokeWidth={2} />
          {starting ? "Opening the sign-in page…" : "Sign in"}
        </Button>
        {shownError ? (
          <p role="alert" className="text-body leading-relaxed text-error-text">
            {shownError}
          </p>
        ) : null}
      </div>
      <p className="flex items-center justify-center gap-1.5 text-meta text-fg-tertiary">
        Cerium never sees your password.
        <InfoTip label="Sign-in options">
          Google, GitHub, X or an email and password, on Cerium's sign-in page.
        </InfoTip>
      </p>
    </>
  );
}

/** Signed in, before the relay has said anything about this device. */
function Connecting({
  connection,
}: {
  connection: Extract<AccountState, { _tag: "SignedIn" }>["connection"];
}) {
  return (
    <div className="flex items-center gap-2.5 text-reading text-fg-secondary">
      <RefreshCw size={15} strokeWidth={1.75} className="animate-spin text-fg-tertiary" />
      {connection === "offline"
        ? "Can't reach Cerium's cloud. Cerium keeps trying."
        : "Connecting to your account…"}
    </div>
  );
}
