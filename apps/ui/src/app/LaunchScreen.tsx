import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { accountAtom } from "../backend/atoms.ts";
import { connectionAtom, localConnectionAtom } from "../backend/client.ts";
import { machineAtom } from "../backend/machine.ts";
import { shellBridge } from "../backend/shell.ts";
import { WEB } from "../backend/target.ts";
import { CeriumMark } from "../components/CeriumMark.tsx";
import { opensOnLaunch, stepFromQuery, WELCOMED_KEY } from "../features/onboarding/model.ts";
import {
  threadCountAtom,
  welcomeOpenAtom,
  welcomeShownAtom,
  windowCoveredAtom,
} from "../features/onboarding/state.ts";
import { Welcome } from "../features/onboarding/Welcome.tsx";
import { themeSettled } from "../features/settings/theme.ts";
import { remember, stored } from "../lib/storage.ts";
import { launchedAtom, launchProgress, launchStatus, letterShape, type LaunchState } from "./launch.ts";

/** How long the mark takes to settle; the window is never handed over before it has. */
const SETTLE_MS = 700;
/** How long starting goes before the screen says what it waits on. */
const QUIET_MS = 1_400;
/** How long the full progress line holds before the window takes over. */
const FULL_MS = 280;
/** The window shows whatever it has by now, with its own notices for what's still missing. */
const GIVE_UP_MS = 12_000;
/** How much of the step under way the progress line creeps through while it waits, and how slowly. */
const CREEP = 0.7;
const CREEP_MS = 4_000;
const STEP_MS = 360;
/** How many times larger than the titlebar's lockup the launch screen draws it. */
const LOCKUP = 64 / 22;
/** The name a letter at a time, each filling out on its own. */
const NAME = ["c", "e", "r", "i", "u", "m"] as const;

/**
 * The window while Cerium starts: its glass, the mark settling into focus as if polished (cerium oxide
 * polishes glass) with its facet turning, and beside it the name, which fills out from thin and
 * condensed to its own lettering as each step of starting finishes. The window underneath loads all
 * along, unseen; when it's ready the mark and the name fly to their place at the top of it and the
 * window fades in around them.
 *
 * On a computer's first run the mark flies to the welcome's instead (features/onboarding), and the
 * window waits under it until the welcome is finished or skipped; the command palette opens the
 * welcome again over it.
 */
export function Launch({ children }: { children: ReactNode }) {
  const [launching, setLaunching] = useState(true);
  const [welcoming, setWelcoming] = useState(false);
  const [asked, setAsked] = useAtom(welcomeOpenAtom);
  const threadCount = useAtomValue(threadCountAtom);
  /** Swaps what the window shows, with the mark flying between the two where the browser can. */
  const swap = (update: () => void, type: "launch" | "welcome") => {
    const finish = () => flushSync(update);
    // Without view transitions the screen simply gives way; the types keep these styles to this one.
    if (document.startViewTransition === undefined) finish();
    else if ("types" in ViewTransition.prototype) {
      document.startViewTransition({ update: finish, types: [type] });
    } else document.startViewTransition(finish);
  };
  const handOver = () => {
    const welcome =
      opensOnLaunch({ web: WEB, welcomed: stored(WELCOMED_KEY), threads: threadCount }) ||
      (import.meta.env.DEV && stepFromQuery(location.search) !== undefined);
    swap(() => {
      setLaunching(false);
      setWelcoming(welcome);
    }, "launch");
  };
  const finishWelcome = () => {
    remember(WELCOMED_KEY, "done");
    setAsked(false);
    swap(() => setWelcoming(false), "welcome");
  };
  // A computer that already has threads knows its way around: the welcome doesn't open there later.
  useEffect(() => {
    if (!WEB && threadCount !== undefined && threadCount > 0 && stored(WELCOMED_KEY) === undefined) {
      remember(WELCOMED_KEY, "done");
    }
  }, [threadCount]);
  const setShown = useAtomSet(welcomeShownAtom);
  useEffect(() => setShown(welcoming), [welcoming, setShown]);
  const setCovered = useAtomSet(windowCoveredAtom);
  useEffect(() => setCovered(launching || welcoming), [launching, welcoming, setCovered]);
  const openAsked = useEffectEvent(() => {
    if (asked && !launching && !welcoming) swap(() => setWelcoming(true), "welcome");
  });
  useEffect(() => openAsked(), [asked, launching]);

  const hidden = launching || welcoming;
  return (
    <>
      {/* Mounted from the start, so it loads while the screen shows; kept the same element after. */}
      <div
        data-launching={hidden ? "" : undefined}
        inert={welcoming}
        className={`h-full ${hidden ? "opacity-0" : ""}`}
      >
        {children}
      </div>
      {launching ? (
        <LaunchScreen onReady={handOver} />
      ) : welcoming ? (
        <Welcome onDone={finishWelcome} />
      ) : null}
    </>
  );
}

function LaunchScreen({ onReady }: { onReady: () => void }) {
  const driven = useAtomValue(machineAtom);
  const backend = useAtomValue(localConnectionAtom) === "connected";
  const account = AsyncResult.isSuccess(useAtomValue(accountAtom));
  const connection = useAtomValue(connectionAtom);
  const launched = useAtomValue(launchedAtom);
  const [shown, setShown] = useState(false);
  const [settled, setSettled] = useState(false);
  const [talking, setTalking] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const state: LaunchState = {
    backend,
    account,
    machine: WEB || driven !== undefined ? connection === "connected" : undefined,
    ready: launched || gaveUp,
  };
  const leaving = state.ready && settled;
  const { done, next } = launchProgress(state);

  // Shown once painted in the user's theme: the desktop shell opens the window then.
  useEffect(() => {
    let frame = 0;
    void themeSettled.then(() => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          shellBridge()?.windowReady?.();
          setShown(true);
        });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!shown) return;
    const timers = [
      setTimeout(() => setSettled(true), SETTLE_MS),
      setTimeout(() => setTalking(true), QUIET_MS),
      setTimeout(() => setGaveUp(true), GIVE_UP_MS),
    ];
    return () => timers.forEach(clearTimeout);
  }, [shown]);
  // Each finished step fills the line to it; then it creeps on through the next until that finishes.
  const target = leaving ? 1 : done;
  const [creepingFrom, setCreepingFrom] = useState<number>();
  const line =
    creepingFrom === target && !leaving
      ? { at: target + next * CREEP, ms: CREEP_MS }
      : { at: target, ms: STEP_MS };
  useEffect(() => {
    if (!shown) return;
    const creep = setTimeout(() => setCreepingFrom(target), STEP_MS);
    return () => clearTimeout(creep);
  }, [shown, target]);
  const lockup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!leaving) return;
    // The facet finishes the turn it's in rather than snapping back mid-turn.
    for (const animation of lockup.current?.getAnimations({ subtree: true }) ?? []) {
      if (!(animation instanceof CSSAnimation) || animation.animationName !== "launch-facet") continue;
      const turn = animation.effect?.getComputedTiming().currentIteration;
      if (typeof turn === "number") animation.effect?.updateTiming({ iterations: turn + 1 });
    }
    const timer = setTimeout(onReady, STEP_MS + FULL_MS);
    return () => clearTimeout(timer);
  }, [leaving, onReady]);

  const status = launchStatus(state, { web: WEB, ...(driven ? { machineName: driven.name } : {}) });
  return (
    <div
      aria-busy="true"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-surface-window pb-10"
    >
      {/* The window can still be moved while it starts; the system draws its buttons over this. */}
      <div className="absolute inset-x-0 top-0 h-10 [app-region:drag]" />
      {shown ? (
        <>
          {/* Cerium's lockup (components/CeriumBrand.tsx) at LOCKUP times its size, so both fly to it. */}
          <div
            ref={lockup}
            // The name is the progress: a <progress> can't be drawn as letters.
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="progressbar"
            aria-label="Starting Cerium"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(line.at * 100)}
            style={{ gap: 8 * LOCKUP }}
            className="flex items-center text-fg-primary"
          >
            <CeriumMark
              size={22 * LOCKUP}
              landing
              facetClassName="origin-center [transform-box:fill-box] animate-[launch-facet_700ms_ease-in-out_infinite] motion-reduce:animate-none"
              className="animate-[launch-settle_700ms_var(--ease-out-soft)_both] motion-reduce:animate-[launch-fade_300ms_ease-out_both]"
            />
            <span
              data-launch-name=""
              aria-hidden="true"
              style={{ fontSize: 16 * LOCKUP }}
              className="flex font-display leading-none tracking-[0.02em] [font-size-adjust:none]"
            >
              {NAME.map((letter, index) => {
                const shape = letterShape(line.at, index);
                return (
                  <span
                    key={index}
                    style={{
                      fontStretch: `${shape.stretch}%`,
                      fontWeight: shape.weight,
                      opacity: shape.opacity,
                      transitionDuration: `${line.ms}ms`,
                      animationDelay: `${120 + index * 70}ms`,
                    }}
                    className="animate-[launch-letter_380ms_var(--ease-out-soft)_backwards] transition-[font-stretch,font-weight,opacity] ease-out-soft motion-reduce:animate-[launch-fade_300ms_ease-out_both] motion-reduce:transition-none"
                  >
                    {letter}
                  </span>
                );
              })}
            </span>
          </div>
          {/* Said only once starting takes long enough to wonder about. */}
          <output
            key={talking ? status : "quiet"}
            className={`mt-12 h-4 text-meta leading-4 text-fg-tertiary ${
              talking ? "animate-[launch-fade_360ms_ease-out_both]" : "invisible"
            }`}
          >
            {status}
          </output>
        </>
      ) : null}
    </div>
  );
}
