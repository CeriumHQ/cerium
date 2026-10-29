import { Button } from "@base-ui/react/button";
import type { ProviderId, UsageSnapshot } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  CalendarSync,
  CircleCheck,
  GitPullRequest,
  House,
  MessagesSquare,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { useRef } from "react";
import { usageAtom } from "../backend/usage.ts";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { SlidingHighlight } from "../components/SlidingHighlight.tsx";
import { Tooltip } from "../components/ui/Tooltip.tsx";
import { harnessName } from "../features/settings/Harnesses.tsx";
import { leftLabel, planName, resetLabel } from "../features/settings/usageModel.ts";
import type { ThreadSummary } from "../features/threads/model.ts";
import type { HarnessIndicator } from "../features/threads/Sidebar.tsx";
import { bindingFor, shortcutBindingsAtom, type ShortcutId } from "../lib/shortcuts.ts";
import { useMinute } from "../lib/useMinute.ts";
import { badgeLabel, badgeNote, railBadges, usageRings, type UsageRing } from "./railModel.ts";

/**
 * Where the rail goes: the work inbox, the chats, the user's own tasks, GitHub's pull requests and
 * issues, the automations that start threads, or settings.
 */
export type RailView = "home" | "chat" | "tasks" | "github" | "automations" | "settings";

const views: ReadonlyArray<{ view: RailView; label: string; icon: LucideIcon; shortcut: ShortcutId }> = [
  { view: "home", label: "Home", icon: House, shortcut: "switch-to-work" },
  { view: "chat", label: "Chat", icon: MessagesSquare, shortcut: "switch-to-chat" },
  { view: "tasks", label: "Tasks", icon: CircleCheck, shortcut: "open-tasks" },
  { view: "github", label: "GitHub", icon: GitPullRequest, shortcut: "open-github" },
  { view: "automations", label: "Automations", icon: CalendarSync, shortcut: "open-automations" },
  { view: "settings", label: "Settings", icon: Settings, shortcut: "open-settings" },
];

interface RailProps {
  readonly view: RailView;
  readonly onSelect: (view: RailView) => void;
  readonly harnesses: ReadonlyArray<HarnessIndicator>;
  /** Every thread the sidebar knows, for the counts on Home and Chat. */
  readonly threads: ReadonlyArray<ThreadSummary>;
  /** Settings → Usage, where a ring's limits are laid out in full. */
  readonly onOpenUsage: () => void;
  /** The places the driven machine can't serve, left off the rail. */
  readonly hidden?: ReadonlyArray<RailView>;
  /** A column down the window's edge, or a row along a phone's foot. */
  readonly orientation?: "vertical" | "horizontal";
}

/**
 * The window's places, as icons down its left edge, over a ring per subscribed harness showing what's
 * left of its tightest limit. Home and Chat count what's new or waiting on the user, and Settings
 * carries a dot while a harness waits to be signed in or set up.
 */
export function Rail({
  view,
  onSelect,
  harnesses,
  threads,
  onOpenUsage,
  hidden = [],
  orientation = "vertical",
}: RailProps) {
  const vertical = orientation === "vertical";
  const badges = railBadges(threads, useMinute());
  const places = useRef<HTMLElement>(null);
  const bindings = useAtomValue(shortcutBindingsAtom);
  // The backend reports every adapter it has, so all "unsupported" is the list before its first answer.
  const checking = harnesses.every(({ state }) => state === "unsupported");
  const waiting =
    !checking && harnesses.some(({ state, needsSetup }) => state === "loggedOut" || needsSetup === true);
  const ready = new Set(harnesses.flatMap(({ provider, state }) => (state === "ready" ? [provider] : [])));
  const shown = views.filter(({ view: id }) => !hidden.includes(id));
  return (
    <div
      className={
        vertical
          ? "flex h-full w-full flex-col items-center gap-1 py-1.5"
          : // Wrapping from the bottom: a phone held upright has no room for the rings beside the places,
            // so they stack above them rather than run off the edge; sideways they share the row.
            "flex w-full flex-wrap-reverse items-center justify-center gap-x-2 border-t border-line-subtle px-3 pt-1"
      }
    >
      <nav
        ref={places}
        aria-label="Places"
        // Never narrower than its places at their touch size, which is what sends the rings above.
        style={vertical ? undefined : { minWidth: shown.length * 44 }}
        className={`relative isolate ${vertical ? "flex flex-col gap-1" : "flex flex-1 justify-around"}`}
      >
        {/* Slides from the place that was open to the one that is. */}
        <SlidingHighlight within={places} active={view} className="rounded-lg bg-surface-selected" />
        {shown.map(({ view: id, label, icon: Icon, shortcut }) => {
          const active = id === view;
          const badge = id === "home" || id === "chat" ? badges[id] : undefined;
          return (
            <Tooltip
              key={id}
              label={badge ? `${label} · ${badgeNote(badge)}` : label}
              shortcut={bindingFor(bindings, shortcut)}
              side={vertical ? "right" : "top"}
            >
              <Button
                aria-label={badge ? `${label}, ${badgeNote(badge)}` : label}
                aria-current={active ? "page" : undefined}
                {...(active ? { "data-highlight-active": "" } : {})}
                onClick={() => onSelect(id)}
                className={`relative grid size-9 place-items-center rounded-lg transition-colors duration-150 max-md:size-11 ${
                  active
                    ? "text-fg-primary"
                    : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
                }`}
              >
                <Icon size={18} strokeWidth={1.75} />
                {badge ? (
                  <span
                    aria-hidden
                    // A badge that turns urgent pops in again at its new colour, as a thread's status dot does.
                    key={badge.waiting > 0 ? "waiting" : "unread"}
                    className={`absolute top-0.5 right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full px-1 text-[9.5px] leading-none font-semibold tabular-nums transition-[scale] duration-300 ease-pop starting:scale-0 max-md:top-1 max-md:right-1 ${
                      badge.waiting > 0
                        ? "bg-attention text-fg-primary dark:text-accent-fg"
                        : "bg-accent text-accent-fg"
                    }`}
                  >
                    {badgeLabel(badge.count)}
                  </span>
                ) : null}
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
  const rings = usageRings(snapshot?.usage ?? [], ready);
  if (rings.length === 0) return null;
  return (
    <div
      aria-label="Usage limits"
      className={
        vertical ? "mt-auto flex flex-col items-center gap-1.5" : "flex items-center justify-center gap-2"
      }
    >
      {rings.map((ring) => (
        <Tooltip
          key={ring.provider}
          side={vertical ? "right" : "top"}
          delay={0}
          label={<RingTip ring={ring} now={now} />}
        >
          <Button
            aria-label={`${harnessName[ring.provider]}: ${Math.round(ring.left)}% left`}
            onClick={onOpen}
            className="group grid size-9 place-items-center rounded-lg transition-colors duration-150 hover:bg-surface-hover max-md:size-11"
          >
            <Ring ring={ring} />
          </Button>
        </Tooltip>
      ))}
    </div>
  );
}

const SIZE = 30;
const STROKE = 2;
const RADIUS = SIZE / 2 - STROKE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * A limit is quiet, in the rail's own grey, while there's plenty of it; it takes a colour only once it
 * needs the eye: amber under a quarter left, red under a tenth.
 */
const arcTone = (left: number) =>
  left >= 25
    ? { stroke: "stroke-fg-tertiary group-hover:stroke-fg-secondary", fill: "bg-fg-tertiary" }
    : left >= 10
      ? { stroke: "stroke-attention", fill: "bg-attention" }
      : { stroke: "stroke-error", fill: "bg-error" };

/**
 * The harness's mark inside one arc, its tightest limit, emptying clockwise from the top as that limit
 * runs down over a faint track of the whole; the tooltip lists the rest.
 */
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
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - ring.left / 100)}
          className={`${arcTone(ring.left).stroke} transition-[stroke-dashoffset,stroke] duration-700 ease-out-soft`}
        />
      </svg>
      <ProviderLogo
        provider={ring.provider}
        size={14}
        className="text-fg-secondary transition-colors duration-150 group-hover:text-fg-primary"
      />
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
      {ring.meters.map((meter) => {
        const drawn = meter.label === ring.label;
        return (
          <span key={meter.label} className="flex flex-col">
            <span className="flex justify-between gap-6 tabular-nums">
              <span className="flex items-center gap-1.5 text-fg-secondary">
                {/* The ring's colour on the limit it draws; the others keep the gap. */}
                <span className={`size-2 rounded-full ${drawn ? arcTone(ring.left).fill : ""}`} />
                {meter.label}
              </span>
              {leftLabel(meter)}
            </span>
            {meter.resetsAt === undefined ? null : (
              <span className="pl-3.5 text-caption text-fg-tertiary">
                {resetLabel(meter.resetsAt, now, meter.resetDayOnly)}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
