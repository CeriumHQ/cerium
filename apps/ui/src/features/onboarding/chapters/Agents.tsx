import { Button } from "@base-ui/react/button";
import { OFFERED_PROVIDERS, type HarnessStatus, type ProviderId } from "@cerium/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ArrowUpRight, Check, RefreshCw } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { harnessesAtom, modelsAtom } from "../../../backend/atoms.ts";
import { ProviderLogo } from "../../../components/ProviderLogo.tsx";
import { accountLabel } from "../../settings/harnessModel.ts";
import { harnessName, installUrl, useHarnessFlows } from "../../settings/Harnesses.tsx";
import { harnessReadiness, readinessSummary, type Readiness } from "../model.ts";
import { Eyebrow, Headline, Reveal } from "../parts.tsx";
import { lightOf, markIn, usePose, usePulse, type Posing } from "../scene.tsx";
import type { ChapterProps } from "../Welcome.tsx";

type Installed = Extract<HarnessStatus, { _tag: "HarnessInstalled" }>;

/** How brightly each harness's beam reaches its row: full once it can run, faint while it can't yet. */
const BRIGHTNESS: Record<Readiness, number> = { ready: 1, attention: 0.22, missing: 0, unknown: 0.12 };

/** The light falls into the mark beside the harnesses, and each beam reaches its own row. */
const pose =
  (statuses: ReadonlyArray<Readiness>): Posing =>
  (stage) => {
    const { facet, ...mark } = markIn(stage, "agents", {
      x: stage.width * 0.55,
      y: stage.height * 0.5,
      size: 150,
    });
    return {
      mark: { ...mark, opacity: 1 },
      incoming: { from: { x: mark.x + stage.width * 0.05, y: -80 }, intensity: 1 },
      beams: OFFERED_PROVIDERS.map((provider, index) => {
        const row = lightOf(stage, provider, "agents");
        if (row === undefined) return { ...facet, intensity: 0 };
        return {
          x: row.x + 2,
          y: row.y + row.height / 2,
          intensity: BRIGHTNESS[statuses[index] ?? "unknown"],
        };
      }),
      dust: 0.8,
    };
  };

/**
 * The fourth chapter: the harnesses on this computer, as they really are. Each beam lights up as its
 * harness is ready to run, and each row offers the one thing to do about it: install, sign in or set up.
 */
export function Agents({ number, titleId, active }: ChapterProps) {
  const result = useAtomValue(harnessesAtom);
  const refreshHarnesses = useAtomRefresh(harnessesAtom);
  const refreshModels = useAtomRefresh(modelsAtom);
  const statuses = AsyncResult.getOrElse(result, (): ReadonlyArray<HarnessStatus> | undefined => undefined);
  const check = () => {
    refreshHarnesses();
    refreshModels();
  };
  const readiness = OFFERED_PROVIDERS.map((provider) =>
    harnessReadiness(statuses?.find((status) => status.provider === provider)),
  );
  usePose(active, pose(readiness), readiness.join());
  // A harness coming ready, as a sign-in finishes, sends a pulse down the light to it.
  const pulse = usePulse();
  const ready = readiness.filter((each) => each === "ready").length;
  const readyBefore = useRef(ready);
  useEffect(() => {
    if (ready > readyBefore.current && active) pulse();
    readyBefore.current = ready;
  }, [ready, active, pulse]);
  const failed = AsyncResult.isFailure(result) && statuses === undefined;
  const summary = failed ? "Couldn't check the harnesses" : readinessSummary(readiness);
  const none = !failed && statuses !== undefined && !readiness.includes("ready");

  return (
    <div className="grid h-full grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] items-center gap-[clamp(24px,5vw,96px)] px-(--welcome-gutter) pb-[2vh]">
      <div className="flex flex-col">
        <Eyebrow number={number}>Harnesses</Eyebrow>
        <Headline
          id={titleId}
          lines={["Bring your", "agents."]}
          className="text-[length:clamp(48px,min(6.6vw,11vh),112px)]"
        />
        <Reveal
          order={3}
          as="p"
          className="mt-[clamp(18px,3.4vh,32px)] max-w-[26rem] text-[15px] leading-relaxed text-fg-secondary"
        >
          Each agent is the harness itself, run through its own SDK on your own plan. Install any of them and
          sign in as usual: Cerium finds them, and never reads their keys.
        </Reveal>
        <Reveal order={4} className="mt-[clamp(22px,4vh,40px)] flex flex-wrap items-center gap-x-4 gap-y-2">
          <output aria-live="polite" className={`text-[13px] ${failed ? "text-error" : "text-fg-primary"}`}>
            {summary}
          </output>
          <Button
            onClick={check}
            disabled={result.waiting}
            className="flex h-8 items-center gap-1.5 rounded-full border border-line-subtle px-3.5 text-[12.5px] text-fg-secondary transition-colors hover:border-line-strong hover:text-fg-primary disabled:text-fg-tertiary"
          >
            <RefreshCw size={12} strokeWidth={1.75} className={result.waiting ? "animate-spin" : ""} />
            {result.waiting ? "Checking…" : "Check again"}
          </Button>
          {none ? (
            <p className="w-full text-[12.5px] leading-relaxed text-fg-tertiary">
              You can carry on, and set one up later from Settings → Harnesses.
            </p>
          ) : null}
        </Reveal>
      </div>

      <div className="grid grid-cols-[clamp(104px,12vw,180px)_minmax(0,1fr)] items-center gap-x-[clamp(28px,5vw,88px)]">
        {/* The light draws the mark here. */}
        <div data-light="mark" className="aspect-square w-full" />
        <ul className="flex flex-col gap-[clamp(6px,1.2vh,12px)]">
          {OFFERED_PROVIDERS.map((provider, index) => (
            <li key={provider} data-light={provider}>
              <Reveal order={3 + index * 0.5}>
                <HarnessCard
                  provider={provider}
                  status={statuses?.find((status) => status.provider === provider)}
                  unknown={statuses === undefined}
                  onChanged={check}
                />
              </Reveal>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** One harness: its mark, its name, the account it runs on or what it needs, and what to do about it. */
function HarnessCard({
  provider,
  status,
  unknown,
  onChanged,
}: {
  readonly provider: ProviderId;
  readonly status: HarnessStatus | undefined;
  readonly unknown: boolean;
  readonly onChanged: () => void;
}) {
  if (unknown || status === undefined) {
    return (
      <Card provider={provider} readiness="unknown" detail={unknown ? "Checking…" : "Not supported yet"} />
    );
  }
  if (status._tag === "HarnessMissing") {
    const url = installUrl(status);
    return (
      <Card
        provider={provider}
        readiness="missing"
        detail="Not installed"
        action={
          url === undefined ? undefined : (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="flex h-7.5 items-center gap-1 rounded-full border border-line-subtle pr-2.5 pl-3 text-[12px] text-fg-secondary transition-colors hover:border-line-strong hover:text-fg-primary"
            >
              Install
              <ArrowUpRight size={12} strokeWidth={1.75} />
            </a>
          )
        }
      />
    );
  }
  return <InstalledCard status={status} onChanged={onChanged} />;
}

function InstalledCard({
  status,
  onChanged,
}: {
  readonly status: Installed;
  readonly onChanged: () => void;
}) {
  const flows = useHarnessFlows(status, onChanged);
  const readiness = harnessReadiness(status);
  const { auth, setup } = status;
  const pill =
    "flex h-7.5 items-center rounded-full bg-accent px-3.5 text-[12px] font-medium text-accent-fg transition-opacity hover:opacity-90";
  return (
    <>
      <Card
        provider={status.provider}
        readiness={readiness}
        detail={
          auth._tag === "LoggedOut"
            ? "Not signed in"
            : setup
              ? "Needs setup"
              : `${accountLabel(auth)} · ${status.version}`
        }
        action={
          auth._tag === "LoggedOut" ? (
            <Button onClick={flows.signIn} className={pill}>
              Sign in
            </Button>
          ) : setup ? (
            <Button onClick={flows.setUp} className={pill}>
              Set up
            </Button>
          ) : (
            <span className="flex h-7.5 items-center gap-1.5 pr-1 text-[12px] text-success">
              <Check size={14} strokeWidth={2} />
              Ready
            </span>
          )
        }
      />
      {flows.dialogs}
    </>
  );
}

function Card({
  provider,
  readiness,
  detail,
  action,
}: {
  readonly provider: ProviderId;
  readonly readiness: Readiness;
  readonly detail: string;
  readonly action?: ReactNode;
}) {
  const ready = readiness === "ready";
  return (
    <div
      data-readiness={readiness}
      className="flex items-center gap-3 rounded-2xl border border-line-subtle bg-surface-raised py-[clamp(7px,1.25vh,11px)] pr-2.5 pl-3 shadow-raised backdrop-blur-xl transition-colors data-[readiness=ready]:border-line-strong"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line-subtle bg-surface-panel text-fg-primary">
        <ProviderLogo provider={provider} size={15} className={ready ? "" : "opacity-45 grayscale"} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={`truncate text-[13px] font-medium ${ready ? "text-fg-primary" : "text-fg-secondary"}`}
        >
          {harnessName[provider]}
        </span>
        <span
          className={`truncate text-[12px] ${readiness === "attention" ? "text-attention" : "text-fg-tertiary"}`}
        >
          {detail}
        </span>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
