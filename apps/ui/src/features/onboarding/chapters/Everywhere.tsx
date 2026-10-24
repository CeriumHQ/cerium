import { Button } from "@base-ui/react/button";
import type { AccountState } from "@cerium/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Check, ExternalLink, LogIn, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { accountAtom, cancelSignIn, signIn } from "../../../backend/atoms.ts";
import { openSignIn } from "../../../backend/signIn.ts";
import { CeriumMark } from "../../../components/CeriumMark.tsx";
import { ProviderLogo } from "../../../components/ProviderLogo.tsx";
import { Eyebrow, Headline, Reveal } from "../parts.tsx";
import { lightOf, markIn, usePose, usePulse, type Posing } from "../scene.tsx";
import type { ChapterProps } from "../Welcome.tsx";

/** How long after the chapter comes in the phone's notifications arrive, one and then the other. */
const NOTIFY_AFTER = [1_500, 2_700] as const;

/**
 * Every beam meets again at the phone, once a notification arrives there: whatever the agents are
 * doing reaches you.
 */
const pose =
  (arrived: boolean): Posing =>
  (stage) => {
    const { x, y, size } = markIn(stage, "everywhere", {
      x: stage.width * 0.5,
      y: stage.height * 0.5,
      size: 130,
    });
    const mark = { x, y };
    const phone = lightOf(stage, "phone", "everywhere");
    const notice = lightOf(stage, "notice", "everywhere");
    // The beams land on the notification, inside the phone's edge.
    const target = {
      x: (phone?.x ?? stage.width * 0.8) + 10,
      y: notice === undefined ? mark.y : notice.y + notice.height * 0.4,
    };
    return {
      mark: { ...mark, size, opacity: 1 },
      incoming: { from: { x: mark.x + stage.width * 0.04, y: -80 }, intensity: 1 },
      beams: [-2, -1, 0, 1, 2].map((offset) => ({
        x: target.x,
        y: target.y + offset * 3,
        intensity: arrived ? 0.7 : 0,
      })),
      dust: 0.7,
    };
  };

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Couldn't start signing in. Try again.";

/**
 * The fifth chapter, and the one to pass by: signing in to a Cerium account, so the user's phone and
 * other computers follow this one's threads. Signed out, nothing leaves the computer.
 */
export function Everywhere({ number, titleId, active, onNext }: ChapterProps) {
  const [arrived, setArrived] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timers = NOTIFY_AFTER.map((after, index) => setTimeout(() => setArrived(index + 1), after));
    return () => timers.forEach(clearTimeout);
  }, [active]);
  usePose(active, pose(arrived > 0), arrived);
  const pulse = usePulse();
  useEffect(() => {
    if (arrived === 1) pulse();
  }, [arrived, pulse]);

  return (
    <div className="grid h-full grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] items-center gap-[clamp(24px,5vw,96px)] px-(--welcome-gutter) pb-[2vh]">
      <div className="flex flex-col">
        <Eyebrow number={number}>Your account</Eyebrow>
        <Headline
          id={titleId}
          lines={["Answer from", "anywhere."]}
          className="text-[length:clamp(44px,min(6vw,10.5vh),104px)]"
        />
        <Reveal
          order={3}
          as="p"
          className="mt-[clamp(18px,3.4vh,32px)] max-w-[26rem] text-[15px] leading-relaxed text-fg-secondary"
        >
          Sign in, and your phone and your other computers follow this one's threads, with a notification when
          an agent needs you. It's optional: signed out, nothing leaves this computer.
        </Reveal>
        <Reveal order={4} className="mt-[clamp(22px,4vh,40px)]">
          <AccountStep onSkip={onNext} />
        </Reveal>
      </div>

      <div className="grid grid-cols-[clamp(96px,10vw,150px)_auto] items-center justify-center gap-x-[clamp(36px,7vw,120px)]">
        {/* The light draws the mark here. */}
        <div data-light="mark" className="aspect-square w-full" />
        <Reveal order={3}>
          <Phone arrived={arrived} />
        </Reveal>
      </div>
    </div>
  );
}

/** Signing in, as Settings → Account does it, or how it went. */
function AccountStep({ onSkip }: { readonly onSkip: () => void }) {
  const result = useAtomValue(accountAtom);
  const account = AsyncResult.isSuccess(result) ? result.value : undefined;
  const start = useAtomSet(signIn, { mode: "promise" });
  const cancel = useAtomSet(cancelSignIn, { mode: "promise" });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();

  const begin = () => {
    setStarting(true);
    setError(undefined);
    void start({ payload: undefined }).then(
      ({ url }) => {
        setStarting(false);
        openSignIn(url);
      },
      (failure: unknown) => {
        setStarting(false);
        setError(messageOf(failure));
      },
    );
  };

  if (account?._tag === "SignedIn") return <SignedIn account={account} />;
  if (account?._tag === "SigningIn") {
    return (
      <div className="flex max-w-[26rem] items-center gap-3 rounded-2xl border border-line-subtle bg-surface-raised py-2 pr-2 pl-3.5 text-[12.5px] shadow-raised">
        <RefreshCw size={13} strokeWidth={1.75} className="shrink-0 animate-spin text-fg-tertiary" />
        <p className="min-w-0 flex-1 text-fg-secondary">Finish signing in using your browser.</p>
        <a
          href={account.url}
          target="_blank"
          rel="noreferrer"
          className="flex h-7.5 items-center gap-1.5 rounded-full px-2.5 text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
        >
          <ExternalLink size={12} strokeWidth={1.75} />
          Open again
        </a>
        <Button
          onClick={() => void cancel({ payload: undefined })}
          className="flex h-7.5 items-center rounded-full px-2.5 text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary"
        >
          Cancel
        </Button>
      </div>
    );
  }
  const shownError = error ?? (account?._tag === "SignedOut" ? account.error : undefined);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button
          onClick={begin}
          disabled={starting || account === undefined}
          className="flex h-9 items-center gap-2 rounded-full bg-accent px-4 text-[13px] font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80 disabled:opacity-60"
        >
          <LogIn size={14} strokeWidth={2} />
          {starting ? "Opening your browser…" : "Sign in"}
        </Button>
        <Button
          onClick={onSkip}
          className="flex h-9 items-center rounded-full px-3.5 text-[13px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
        >
          Not now
        </Button>
      </div>
      <p className="text-[12px] text-fg-tertiary">
        Google, GitHub, X or email. Cerium never sees your password.
      </p>
      {shownError ? <p className="max-w-[26rem] text-[12.5px] text-error">{shownError}</p> : null}
    </div>
  );
}

function SignedIn({ account }: { readonly account: Extract<AccountState, { _tag: "SignedIn" }> }) {
  const { name, email } = account.account;
  const others = account.devices.filter((device) => device.id !== account.deviceId).length;
  return (
    <div className="flex max-w-[26rem] items-center gap-3 rounded-2xl border border-line-subtle bg-surface-raised px-3.5 py-3 shadow-raised">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-success/15 text-success">
        <Check size={15} strokeWidth={2} />
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] font-medium text-fg-primary">
          Signed in as {name ?? email ?? "you"}
        </span>
        <span className="truncate text-[12px] text-fg-tertiary">
          {others === 0
            ? "Sign in on your phone to answer from there."
            : `${others} other ${others === 1 ? "device follows" : "devices follow"} this computer.`}
        </span>
      </div>
    </div>
  );
}

/** The time as a phone's lock screen shows it: the hour and minute, no more. */
const lockTime = (date: Date) =>
  new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" })
    .formatToParts(date)
    .filter((part) => part.type !== "dayPeriod")
    .map((part) => part.value)
    .join("")
    .trim();

/**
 * A phone's lock screen, drawn in glass: the time, and Cerium's notifications arriving on it, an agent
 * asking for the user first and another's news after.
 */
function Phone({ arrived }: { readonly arrived: number }) {
  const [now] = useState(() => new Date());
  return (
    <div
      data-light="phone"
      aria-hidden="true"
      className="relative flex aspect-[9/19] h-[clamp(330px,60vh,560px)] flex-col overflow-hidden rounded-[clamp(36px,5.6vh,52px)] border border-line-strong bg-surface-panel p-[clamp(10px,1.6vh,14px)] shadow-overlay backdrop-blur-2xl"
    >
      <div className="welcome-phone-sheen pointer-events-none absolute inset-0" />
      <div className="relative mx-auto mt-1 h-[clamp(18px,3vh,24px)] w-[34%] rounded-full bg-[oklch(0_0_0/0.6)]" />
      <div className="relative mt-[clamp(18px,4vh,40px)] flex flex-col items-center gap-0.5">
        <span className="text-[clamp(10px,1.5vh,12.5px)] text-fg-secondary">
          {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
        </span>
        <span className="font-display text-[clamp(44px,9vh,78px)] leading-none font-extralight font-stretch-expanded text-fg-primary [font-size-adjust:none]">
          {lockTime(now)}
        </span>
      </div>
      <div className="relative mt-auto mb-[clamp(18px,4vh,40px)] flex flex-col gap-2">
        <div
          data-light="notice"
          data-arrived={arrived >= 1 ? "" : undefined}
          className="welcome-notice rounded-[clamp(16px,2.6vh,22px)] border border-line-subtle bg-surface-overlay p-[clamp(9px,1.5vh,12px)] shadow-raised"
        >
          <div className="flex items-center gap-1.5 text-[clamp(9.5px,1.35vh,11px)] text-fg-tertiary">
            <CeriumMark size={12} className="text-fg-primary" />
            <span className="font-medium text-fg-secondary">Cerium</span>
            <span className="ml-auto">now</span>
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-[clamp(11px,1.6vh,13px)] font-medium text-fg-primary">
            <ProviderLogo provider="claude" size={12} />
            Claude Code needs you
          </p>
          <p className="text-[clamp(10.5px,1.5vh,12.5px)] leading-snug text-fg-secondary">
            Wants to run{" "}
            <code className="rounded-[4px] bg-surface-hover px-1 py-px font-mono text-[0.92em] text-fg-primary">
              bun test
            </code>
          </p>
          <div className="mt-2 grid grid-cols-2 gap-1.5 text-[clamp(10px,1.45vh,12px)]">
            <span className="grid h-[clamp(22px,3.4vh,28px)] place-items-center rounded-full bg-accent font-medium text-accent-fg">
              Allow
            </span>
            <span className="grid h-[clamp(22px,3.4vh,28px)] place-items-center rounded-full bg-surface-hover text-fg-secondary">
              Deny
            </span>
          </div>
        </div>
        <div
          data-arrived={arrived >= 2 ? "" : undefined}
          className="welcome-notice rounded-[clamp(16px,2.6vh,22px)] border border-line-subtle bg-surface-overlay/80 p-[clamp(9px,1.5vh,12px)]"
        >
          <div className="flex items-center gap-1.5 text-[clamp(9.5px,1.35vh,11px)] text-fg-tertiary">
            <CeriumMark size={12} className="text-fg-primary" />
            <span className="font-medium text-fg-secondary">Cerium</span>
            <span className="ml-auto">2m ago</span>
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-[clamp(11px,1.6vh,13px)] font-medium text-fg-primary">
            <ProviderLogo provider="codex" size={12} />
            Codex finished
          </p>
          <p className="text-[clamp(10.5px,1.5vh,12.5px)] text-fg-secondary">
            29 tests pass in queue.test.ts
          </p>
        </div>
      </div>
      <div className="relative mx-auto mb-0.5 h-1 w-[36%] rounded-full bg-fg-primary/35" />
    </div>
  );
}
