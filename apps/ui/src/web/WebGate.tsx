import { Button } from "@base-ui/react/button";
import type { AccountState } from "@cerium/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { LogIn } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";

import { useLaunched } from "../app/launch.ts";
import { accountAtom, cancelSignIn, signIn } from "../backend/atoms.ts";
import { openSignIn } from "../backend/signIn.ts";
import { WEB } from "../backend/target.ts";
import { CeriumBrand } from "../components/CeriumBrand.tsx";
import { InfoTip } from "../components/ui/InfoTip.tsx";
import { thisDevice } from "../features/account/model.ts";

// What the web client shows before it may drive anything: signing in, and connecting to the account
// for the first time. Signed out it has nothing to show. It's a page of Cerium's website as much as
// the app's, so it wears the website's look: its bar, its display face and its light
// (styles/gate.css).

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
    <main
      data-gate=""
      data-gate-state={account?._tag === "SignedIn" ? "connecting" : undefined}
      className="relative flex h-full flex-col overflow-x-clip overflow-y-auto bg-surface-window pt-[env(safe-area-inset-top)] pb-[max(env(safe-area-inset-bottom),1.5rem)] select-text"
    >
      {/* The website's bench sits deeper than the window's glass. */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 bg-surface-sunken" />
      <header className="relative flex h-14 shrink-0 items-center gap-2 px-(--gate-gutter) pt-3">
        <a href="/" aria-label="Cerium home" className="rounded-lg">
          <CeriumBrand />
        </a>
        <nav aria-label="Site" className="ml-auto flex items-center">
          <a
            href="/downloads/"
            className="rounded-[10px] px-3.5 py-2 text-reading text-fg-secondary transition-colors duration-150 hover:bg-surface-raised hover:text-fg-primary max-md:text-[15px]"
          >
            Download
          </a>
        </nav>
      </header>
      {account === undefined ? null : (
        <div className="relative flex min-h-[560px] flex-1 flex-col">
          <Split />
          {account._tag === "SignedIn" ? (
            <Connecting connection={account.connection} />
          ) : (
            <SigningIn account={account} />
          )}
        </div>
      )}
    </main>
  );
}

const BANDS = [1, 2, 3, 4, 5] as const;

/**
 * One beam in, five out: this device's way in splitting to every computer on the account, drawn as
 * the website's downloads page splits its beam.
 */
function Split() {
  return (
    <div
      aria-hidden="true"
      className="relative mx-(--gate-gutter) my-[clamp(24px,6vh,64px)] min-h-[120px] flex-1"
    >
      <svg
        viewBox="0 0 1200 240"
        preserveAspectRatio="none"
        className="gate-beam absolute inset-0 size-full overflow-visible"
      >
        <defs>
          <linearGradient id="gate-beam-in" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="600" y2="0">
            <stop offset="0" style={{ stopColor: "var(--fg-primary)", stopOpacity: 0 }} />
            <stop offset="1" style={{ stopColor: "var(--fg-primary)" }} />
          </linearGradient>
          {BANDS.map((band) => (
            <linearGradient
              key={band}
              id={`gate-band-${band}`}
              gradientUnits="userSpaceOnUse"
              x1="600"
              y1="0"
              x2="1200"
              y2="0"
            >
              <stop offset="0" style={{ stopColor: `var(--spectrum-${band})` }} />
              <stop offset="1" style={{ stopColor: `var(--spectrum-${band})`, stopOpacity: 0.15 }} />
            </linearGradient>
          ))}
        </defs>
        <path className="gate-beam-in" pathLength={1} d="M0 120H600" />
        {BANDS.map((band, index) => {
          const y = 24 + index * 48;
          return (
            <path
              key={band}
              className="gate-band"
              pathLength={1}
              d={`M600 120C780 120 900 ${y} 1200 ${y}`}
              stroke={`url(#gate-band-${band})`}
              style={{ "--band": `var(--spectrum-${band})`, "--n": index } as CSSProperties}
            />
          );
        })}
      </svg>
      <div className="gate-facet absolute top-1/2 left-1/2" />
    </div>
  );
}

/** A display headline, a line at a time, its letters stretching out from narrow as it comes in. */
function Headline({ lines }: { lines: ReadonlyArray<string> }) {
  let letter = 0;
  return (
    <h1 className="m-0 font-display text-[clamp(2.75rem,0.5rem+8.4vw,8.5rem)] leading-[0.9] font-[340] tracking-[-0.035em] text-fg-primary [font-size-adjust:none] [font-stretch:118%]">
      <span className="sr-only">{lines.join(" ")}</span>
      <span aria-hidden="true">
        {lines.map((line) => (
          <span key={line} className="block whitespace-nowrap">
            {line.split("").map((character, index) => (
              <span key={index} data-letter="" style={{ "--i": letter++ } as CSSProperties}>
                {character === " " ? " " : character}
              </span>
            ))}
          </span>
        ))}
      </span>
    </h1>
  );
}

/** Rises in after the headline, `order` steps behind it. */
function Rise({
  order,
  className = "",
  children,
}: {
  order: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div data-reveal="" style={{ "--d": order } as CSSProperties} className={className}>
      {children}
    </div>
  );
}

/** The page's headline, and beside it on a wide screen what it says and does. */
function Stage({ lines, children }: { lines: ReadonlyArray<string>; children: ReactNode }) {
  return (
    <section
      // A new headline comes in afresh.
      key={lines.join(" ")}
      className="flex flex-wrap items-end justify-between gap-x-16 gap-y-7 px-(--gate-gutter) pb-[clamp(16px,6vh,72px)]"
    >
      <Headline lines={lines} />
      <div className="flex w-full max-w-[36ch] flex-col items-start gap-6 max-md:max-w-none">{children}</div>
    </section>
  );
}

function Lede({ children }: { children: ReactNode }) {
  return (
    <Rise order={0}>
      <p className="m-0 max-w-[34ch] text-[clamp(1.0625rem,0.95rem+0.4vw,1.25rem)] leading-normal text-pretty text-fg-secondary">
        {children}
      </p>
    </Rise>
  );
}

const pill =
  "flex h-12 items-center justify-center gap-2.5 rounded-full px-6 text-[15px] font-semibold whitespace-nowrap transition-[background-color,box-shadow,scale] duration-200 ease-out-soft active:scale-[0.97] disabled:opacity-60 max-md:w-full";
const solid = `${pill} bg-accent text-accent-fg shadow-[inset_0_0_0_1px_oklch(1_0_0/0.2),0_10px_40px_-12px_color-mix(in_oklab,var(--accent)_60%,transparent)] hover:shadow-[inset_0_0_0_1px_oklch(1_0_0/0.3),0_14px_60px_-10px_color-mix(in_oklab,var(--accent)_80%,transparent)]`;
const glass = `${pill} bg-surface-film text-fg-primary shadow-film ring-1 ring-line-subtle ring-inset backdrop-blur-xl hover:bg-surface-raised`;

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
      <Stage lines={["Almost", "there."]}>
        <Lede>This device joins your account once you finish on Cerium's page.</Lede>
        <Rise order={1} className="flex w-full flex-wrap gap-2.5">
          <Button onClick={() => openSignIn(account.url)} className={solid}>
            <LogIn size={17} strokeWidth={2} />
            Continue signing in
          </Button>
          <Button onClick={() => void cancel({ payload: undefined })} className={glass}>
            Cancel
          </Button>
        </Rise>
      </Stage>
    );
  }

  const shownError = error ?? account.error;
  return (
    <Stage lines={["Your agents,", "anywhere."]}>
      <Lede>Sign in to see and continue the threads on all your computers from this device.</Lede>
      <Rise order={1} className="flex w-full flex-col items-start gap-4">
        <Button onClick={begin} disabled={starting} className={solid}>
          <LogIn size={17} strokeWidth={2} />
          {starting ? "Opening the sign-in page…" : "Sign in"}
        </Button>
        {shownError ? (
          <p role="alert" className="m-0 text-reading leading-relaxed text-error-text">
            {shownError}
          </p>
        ) : null}
        <p className="m-0 flex items-center gap-1.5 text-meta text-fg-tertiary max-md:self-center">
          Cerium never sees your password.
          <InfoTip label="Sign-in options">
            Google, GitHub, X or an email and password, on Cerium's sign-in page.
          </InfoTip>
        </p>
      </Rise>
    </Stage>
  );
}

/** Signed in, before the relay has said anything about this device. */
function Connecting({
  connection,
}: {
  connection: Extract<AccountState, { _tag: "SignedIn" }>["connection"];
}) {
  return (
    <Stage lines={["One", "moment."]}>
      <Lede>
        <output>
          {connection === "offline"
            ? "Can't reach Cerium's cloud. Cerium keeps trying."
            : "Connecting to your account…"}
        </output>
      </Lede>
    </Stage>
  );
}
