import { Button } from "@base-ui/react/button";
import type { ProviderId, UsageSnapshot } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { House, MessagesSquare, Settings, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { usageAtom } from "../backend/usage.ts";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { Tooltip } from "../components/ui/Tooltip.tsx";
import { harnessName } from "../features/settings/Harnesses.tsx";
import { leftLabel, planName, resetLabel } from "../features/settings/usageModel.ts";
import type { HarnessIndicator } from "../features/threads/Sidebar.tsx";
import { usageRings, type UsageRing } from "./railModel.ts";

/** Where the rail goes: the work inbox, the chats, or settings. */
export type RailView = "home" | "chat" | "settings";

const views: ReadonlyArray<{ view: RailView; label: string; icon: LucideIcon; shortcut: string }> = [
  { view: "home", label: "Home", icon: House, shortcut: "Ctrl Shift 1" },
  { view: "chat", label: "Chat", icon: MessagesSquare, shortcut: "Ctrl Shift 2" },
  { view: "settings", label: "Settings", icon: Settings, shortcut: "Ctrl ," },
];

interface RailProps {
  readonly view: RailView;
  readonly onSelect: (view: RailView) => void;
  readonly harnesses: ReadonlyArray<HarnessIndicator>;
  /** Settings → Usage, where a ring's limits are laid out in full. */
  readonly onOpenUsage: () => void;
  /** A column down the window's edge, or a row along a phone's foot. */
  readonly orientation?: "vertical" | "horizontal";
}

/**
 * The window's places, as icons down its left edge, over a ring per subscribed harness showing what's
 * left of its tightest limit. Settings carries a dot while a harness waits to be signed in or set up.
 */
export function Rail({ view, onSelect, harnesses, onOpenUsage, orientation = "vertical" }: RailProps) {
  const vertical = orientation === "vertical";
  // The backend reports every adapter it has, so all "unsupported" is the list before its first answer.
  const checking = harnesses.every(({ state }) => state === "unsupported");
  const waiting =
    !checking && harnesses.some(({ state, needsSetup }) => state === "loggedOut" || needsSetup === true);
  const ready = new Set(harnesses.flatMap(({ provider, state }) => (state === "ready" ? [provider] : [])));
  return (
    <div
      className={
        vertical
          ? "flex h-full w-full flex-col items-center gap-1 py-1.5"
          : "flex w-full items-center gap-1 border-t border-line-subtle px-3 pt-1.5"
      }
    >
      <nav aria-label="Places" className={vertical ? "flex flex-col gap-1" : "flex flex-1 justify-around"}>
        {views.map(({ view: id, label, icon: Icon, shortcut }) => {
          const active = id === view;
          return (
            <Tooltip key={id} label={label} shortcut={shortcut} side={vertical ? "right" : "top"}>
              <Button
                aria-label={label}
                aria-current={active ? "page" : undefined}
                onClick={() => onSelect(id)}
                className={`relative grid size-9 place-items-center rounded-lg transition-colors duration-150 max-md:size-11 ${
                  active
                    ? "bg-surface-selected text-fg-primary"
                    : "text-fg-tertiary hover:bg-surface-hover hover:text-fg-secondary"
                }`}
              >
                <Icon size={18} strokeWidth={1.75} />
                {id === "settings" && waiting ? (
                  <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-attention" />
                ) : null}
              </Button>
            </Tooltip>
          );
        })}
      </nav>
      <UsageRings ready={ready} vertical={vertical} onOpen={onOpenUsage} />
    </div>
  );
}

function useMinute() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function UsageRings({
  ready,
  vertical,
  onOpen,
}: {
  ready: ReadonlySet<ProviderId>;
  vertical: boolean;
  onOpen: () => void;
}) {
  const now = useMinute();
  const snapshot = AsyncResult.getOrElse(useAtomValue(usageAtom), (): UsageSnapshot | undefined => undefined);
  const rings = usageRings(snapshot?.usage ?? [], ready, now);
  if (rings.length === 0) return null;
  return (
    <div
      aria-label="Usage limits"
      className={vertical ? "mt-auto flex flex-col items-center gap-1.5" : "flex items-center gap-1"}
    >
      {rings.map((ring) => (
        <Tooltip
          key={ring.provider}
          side={vertical ? "right" : "top"}
          label={<RingTip ring={ring} now={now} />}
        >
          <Button
            aria-label={`${harnessName[ring.provider]}: ${Math.round(ring.left)}% left`}
            onClick={onOpen}
            className="grid size-9 place-items-center rounded-lg transition-colors duration-150 hover:bg-surface-hover max-md:size-11"
          >
            <Ring ring={ring} />
          </Button>
        </Tooltip>
      ))}
    </div>
  );
}

const SIZE = 30;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const tone = { normal: "text-success", warning: "text-attention", critical: "text-error" } as const;

/** The harness's mark inside an arc that empties clockwise from the top as its limit runs down. */
function Ring({ ring }: { ring: UsageRing }) {
  return (
    <span className="relative grid size-[30px] place-items-center">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="absolute inset-0 -rotate-90">
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          className="stroke-line-strong"
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - ring.left / 100)}
          className={`transition-[stroke-dashoffset] duration-700 ease-out-soft ${tone[ring.level]}`}
        />
      </svg>
      <ProviderLogo provider={ring.provider} size={14} />
    </span>
  );
}

function RingTip({ ring, now }: { ring: UsageRing; now: number }) {
  return (
    <span className="flex flex-col gap-1.5 py-0.5 whitespace-nowrap">
      <span className="font-medium">
        {harnessName[ring.provider]}
        {ring.plan ? <span className="font-normal text-fg-tertiary"> · {planName(ring.plan)}</span> : null}
      </span>
      {ring.meters.map((meter) => (
        <span key={meter.label} className="flex flex-col">
          <span className="flex justify-between gap-6 tabular-nums">
            <span className="text-fg-secondary">{meter.label}</span>
            {leftLabel(meter)}
          </span>
          {meter.resetsAt === undefined ? null : (
            <span className="text-2xs text-fg-tertiary">{resetLabel(meter.resetsAt, now)}</span>
          )}
        </span>
      ))}
    </span>
  );
}
