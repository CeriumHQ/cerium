import { Button } from "@base-ui/react/button";
import type { AccountState } from "@cerium/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Clock, LogIn, RefreshCw, Smartphone } from "lucide-react";
import { useState, type ReactNode } from "react";

import { accountAtom, cancelSignIn, signIn, signOut } from "../backend/atoms.ts";
import { openSignIn } from "../backend/signIn.ts";
import { WEB } from "../backend/target.ts";
import { CeriumMark } from "../components/CeriumMark.tsx";
import { InfoTip } from "../components/ui/InfoTip.tsx";
import { deviceDetails, isApproved, thisDevice } from "../features/account/model.ts";

// What the web client shows before it may drive anything: signing in,
// and waiting for one of the account's devices to allow this one. Signed out it has nothing to show.

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Something went wrong. Try again.";

/** The web client's window once this device may see the account; until then, the way there. */
export function WebGate({ children }: { children: ReactNode }) {
  const result = useAtomValue(accountAtom);
  if (!WEB) return children;
  const account = AsyncResult.isSuccess(result) ? result.value : undefined;
  if (account?._tag === "SignedIn" && isApproved(account)) return children;
  return (
    <main className="flex h-full flex-col items-center justify-center overflow-y-auto bg-surface-window px-6 pt-[max(env(safe-area-inset-top),2rem)] pb-[max(env(safe-area-inset-bottom),2rem)]">
      <div className="flex w-full max-w-sm flex-col gap-7">
        <div className="flex items-center gap-2.5 text-fg-primary">
          <CeriumMark size={22} />
          <span className="text-[17px] font-semibold tracking-tight">Cerium</span>
        </div>
        {account === undefined ? null : account._tag === "SignedIn" ? (
          <Joining account={account} />
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
      <p className="text-[14px] leading-relaxed text-fg-secondary">{children}</p>
    </div>
  );
}

const primary =
  "flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[14px] font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80 disabled:opacity-60";
const quiet =
  "flex h-10 w-full items-center justify-center rounded-xl px-4 text-[13.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary";

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
          <p role="alert" className="text-[13px] leading-relaxed text-error">
            {shownError}
          </p>
        ) : null}
      </div>
      <p className="flex items-center justify-center gap-1.5 text-[12.5px] text-fg-tertiary">
        Cerium never sees your password.
        <InfoTip label="Sign-in options">
          Google, GitHub, X or an email and password, on Cerium's sign-in page.
        </InfoTip>
      </p>
    </>
  );
}

/** Signed in, but not allowed in yet, or not connected yet. */
function Joining({ account }: { account: Extract<AccountState, { _tag: "SignedIn" }> }) {
  const leave = useAtomSet(signOut, { mode: "promise" });
  const self = thisDevice(account);

  // Nothing heard from the relay yet: who this device is and whether it may see anything is unknown.
  if (self === undefined) {
    return (
      <div className="flex items-center gap-2.5 text-[14px] text-fg-secondary">
        <RefreshCw size={15} strokeWidth={1.75} className="animate-spin text-fg-tertiary" />
        {account.connection === "offline"
          ? "Can't reach Cerium's cloud. Cerium keeps trying."
          : "Connecting to your account…"}
      </div>
    );
  }

  return (
    <>
      <Heading title="Waiting for approval">
        Allow it in Settings → Account on one of your computers. Until then it sees nothing.
      </Heading>
      <div className="flex items-center gap-3.5 rounded-xl border border-line-subtle bg-surface-raised px-4 py-3.5">
        <span className="relative grid size-9 shrink-0 place-items-center rounded-lg border border-line-subtle bg-surface-panel text-fg-secondary">
          <Smartphone size={16} strokeWidth={1.75} />
          <span className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full border-2 border-surface-raised bg-attention text-surface-panel">
            <Clock size={9} strokeWidth={2.5} />
          </span>
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[14px] font-medium text-fg-primary">{self.name}</span>
          <span className="truncate text-[12.5px] text-fg-tertiary">{deviceDetails(self)}</span>
        </span>
      </div>
      <Button onClick={() => void leave({ payload: undefined }).catch(() => undefined)} className={quiet}>
        Sign out
      </Button>
    </>
  );
}
