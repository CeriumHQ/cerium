import { Button } from "@base-ui/react/button";
import { OFFERED_PROVIDERS, type HarnessStatus, type ProviderId } from "@cerium/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ArrowUpRight, Check, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { harnessesAtom, modelsAtom } from "../../../backend/atoms.ts";
import { ProviderLogo } from "../../../components/ProviderLogo.tsx";
import { accountLabel } from "../../settings/harnessModel.ts";
import { harnessName, installUrl, useHarnessFlows } from "../../settings/Harnesses.tsx";
import { harnessReadiness, type Readiness } from "../model.ts";
import { Eyebrow, Headline, Reveal } from "../parts.tsx";
import type { StepProps } from "../Welcome.tsx";

type Installed = Extract<HarnessStatus, { _tag: "HarnessInstalled" }>;

/**
 * The step a welcome takes only while no harness on this computer can run a thread: each harness, with
 * the one thing to do about it, install, sign in or set up, as Settings → Harnesses offers.
 */
export function Connect({ number, titleId }: StepProps) {
  const result = useAtomValue(harnessesAtom);
  const refreshHarnesses = useAtomRefresh(harnessesAtom);
  const refreshModels = useAtomRefresh(modelsAtom);
  const statuses = AsyncResult.getOrElse(result, (): ReadonlyArray<HarnessStatus> | undefined => undefined);
  const check = () => {
    refreshHarnesses();
    refreshModels();
  };

  return (
    <div className="grid h-full grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-center gap-[clamp(24px,6vw,120px)] px-(--welcome-gutter) pb-[2vh]">
      <div className="flex flex-col items-start">
        <Eyebrow number={number}>Harnesses</Eyebrow>
        <Headline
          id={titleId}
          lines={["Connect", "a harness."]}
          className="text-[length:clamp(48px,min(6.6vw,11vh),112px)]"
        />
        <Reveal order={3} className="mt-[clamp(22px,4vh,40px)]">
          <Button
            onClick={check}
            disabled={result.waiting}
            className="flex h-8 items-center gap-1.5 rounded-full border border-line-subtle px-3.5 text-meta text-fg-secondary transition-colors hover:border-line-strong hover:text-fg-primary disabled:text-fg-tertiary"
          >
            <RefreshCw size={12} strokeWidth={1.75} className={result.waiting ? "animate-spin" : ""} />
            {result.waiting ? "Checking…" : "Check again"}
          </Button>
        </Reveal>
      </div>
      <ul className="flex flex-col gap-[clamp(6px,1.2vh,12px)]">
        {OFFERED_PROVIDERS.map((provider, index) => (
          <Reveal key={provider} as="li" order={3 + index * 0.5}>
            <HarnessCard
              provider={provider}
              status={statuses?.find((status) => status.provider === provider)}
              unknown={statuses === undefined}
              onChanged={check}
            />
          </Reveal>
        ))}
      </ul>
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
              className="flex h-7.5 items-center gap-1 rounded-full border border-line-subtle pr-2.5 pl-3 text-meta text-fg-secondary transition-colors hover:border-line-strong hover:text-fg-primary"
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
    "flex h-7.5 items-center rounded-full bg-accent px-3.5 text-meta font-medium text-accent-fg transition-opacity hover:opacity-90";
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
            <span className="flex h-7.5 items-center gap-1.5 pr-1 text-meta text-success-text">
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
        <span className={`truncate text-body font-medium ${ready ? "text-fg-primary" : "text-fg-secondary"}`}>
          {harnessName[provider]}
        </span>
        <span
          className={`truncate text-meta ${readiness === "attention" ? "text-attention-text" : "text-fg-tertiary"}`}
        >
          {detail}
        </span>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
