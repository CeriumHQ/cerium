import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";

import { machineAtom } from "../backend/machine.ts";
import { WEB } from "../backend/target.ts";
import { launchedAtom } from "./launch.ts";

/** How long the mark takes to draw itself; the screen never lifts halfway through. */
const INTRO_MS = 900;
/** How long the frost takes to clear once the window is ready. */
const EXIT_MS = 560;
/** The window shows whatever it has by now, with its own notices for what's still missing. */
const GIVE_UP_MS = 12_000;

// Cerium's mark as it draws itself (components/CeriumMark.tsx), in the larger drawing.
const ARC = "M34.6 13.4A15 15 0 1 0 34.6 34.6";
const FACET = "M36 19.5 40.5 24 36 28.5 31.5 24Z";

/**
 * What the window shows while it starts: the mark polishing itself on frosted glass, after cerium
 * oxide, which polishes glass. Its C draws, its facet sets, and light runs across it until the window
 * is ready; then the frost clears onto the window underneath, which has been loading all along.
 */
export function LaunchScreen() {
  const launched = useAtomValue(launchedAtom);
  const driven = useAtomValue(machineAtom);
  const [introDone, setIntroDone] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const [gone, setGone] = useState(false);
  const leaving = (launched && introDone) || gaveUp;

  useEffect(() => {
    const intro = setTimeout(() => setIntroDone(true), INTRO_MS);
    const giveUp = setTimeout(() => setGaveUp(true), GIVE_UP_MS);
    return () => {
      clearTimeout(intro);
      clearTimeout(giveUp);
    };
  }, []);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setGone(true), EXIT_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  if (gone) return null;
  const status = driven ? `Connecting to ${driven.name}` : WEB ? "Connecting" : "Starting up";
  return (
    <div
      aria-hidden={leaving}
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center bg-surface-window transition-[opacity,backdrop-filter] duration-[560ms] ease-out-soft motion-reduce:transition-opacity ${
        leaving ? "pointer-events-none opacity-0 backdrop-blur-none" : "backdrop-blur-3xl"
      }`}
    >
      {/* The window can still be moved while it starts; Windows draws its buttons over this. */}
      <div className="absolute inset-x-0 top-0 h-10 [app-region:drag]" />
      <div
        className={`flex flex-col items-center gap-6 transition-[opacity,scale] duration-300 ease-out-soft ${
          leaving ? "scale-[1.06] opacity-0" : ""
        }`}
      >
        <PolishedMark />
        {/* Said only once starting takes long enough to wonder about. */}
        <output className="h-4 animate-[launch-fade_480ms_ease-out_1.4s_both] text-[12.5px] leading-4 tracking-[0.01em] text-fg-tertiary">
          {status}
        </output>
      </div>
    </div>
  );
}

function PolishedMark() {
  return (
    <svg
      width={60}
      height={60}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      // At rest the mark sits a step below the light that runs across it: a brighter sheen on dark
      // glass, a pale one on light.
      className="overflow-visible [--glint:var(--accent-fg)] [--mark:var(--fg-primary)] dark:[--glint:var(--accent-strong)] dark:[--mark:var(--fg-secondary)]"
    >
      <defs>
        <linearGradient id="launch-glint">
          <stop offset="0" style={{ stopColor: "var(--glint)", stopOpacity: 0 }} />
          <stop offset="0.5" style={{ stopColor: "var(--glint)", stopOpacity: 0.95 }} />
          <stop offset="1" style={{ stopColor: "var(--glint)", stopOpacity: 0 }} />
        </linearGradient>
        <mask id="launch-mark" maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
          <path d={ARC} stroke="white" strokeWidth={6} strokeLinecap="round" />
          <path d={FACET} fill="white" />
        </mask>
      </defs>
      <path
        d={ARC}
        pathLength={1}
        strokeDasharray="1 1"
        stroke="var(--mark)"
        strokeWidth={6}
        strokeLinecap="round"
        className="animate-[launch-draw_820ms_cubic-bezier(0.65,0,0.35,1)_80ms_both] motion-reduce:animate-none"
      />
      <path
        d={FACET}
        fill="var(--mark)"
        className="origin-center animate-[launch-facet_520ms_cubic-bezier(0.34,1.56,0.64,1)_560ms_both] [transform-box:fill-box] motion-reduce:animate-none"
      />
      <g mask="url(#launch-mark)" className="motion-reduce:hidden">
        <g transform="rotate(24 24 24)">
          <rect
            x={-22}
            y={-20}
            width={22}
            height={88}
            fill="url(#launch-glint)"
            className="animate-[launch-glint_2.6s_cubic-bezier(0.45,0,0.25,1)_1s_infinite_both]"
          />
        </g>
      </g>
    </svg>
  );
}
