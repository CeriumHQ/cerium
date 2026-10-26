import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import type { ThreadId } from "@cerium/protocol";
import type { CheckFailure, HookStep, PushAction, PushCheck, PushRecord } from "@cerium/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  Ban,
  Check,
  ChevronRight,
  Circle,
  CircleDashed,
  ExternalLink,
  GitCommitHorizontal,
  LoaderCircle,
  MessageSquareShare,
  RotateCcw,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { pushAction, pushesAtom } from "../../backend/pushes.ts";
import {
  answerOf,
  checkStatus,
  foldedLine,
  headline,
  pushOf,
  runUrl,
  sentLine,
  stepStatus,
  supersededBy,
  type Tone,
} from "./push.ts";
import type { ToolBlock } from "./tools.ts";

// A push the agent made with Cerium's `push` tool: a checklist of the checks GitHub runs on it, as
// they run, so the user needn't open GitHub. Once a newer push follows, it folds to one line.

/** Ticks every second while something on the card is still running. */
function useNow(live: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

const PANEL =
  "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0";

export function PushCard({ call, threadId }: { call: ToolBlock; threadId: ThreadId | undefined }) {
  return threadId === undefined ? (
    <PushOf call={call} pushes={[]} />
  ) : (
    <ThreadPush call={call} threadId={threadId} />
  );
}

function ThreadPush({ call, threadId }: { call: ToolBlock; threadId: ThreadId }) {
  const result = useAtomValue(pushesAtom(threadId));
  return <PushOf call={call} pushes={AsyncResult.isSuccess(result) ? result.value : []} />;
}

function PushOf({ call, pushes }: { call: ToolBlock; pushes: ReadonlyArray<PushRecord> }) {
  const answer = answerOf(call);
  const live = call.status === "running" || pushes.some((push) => isLive(push));
  const now = useNow(live);
  const push = pushOf(call, pushes, now);
  if (push === undefined) {
    if (answer?.status === "denied") {
      return <Line icon={Ban} tone="quiet" text="Push not allowed" detail={answer.note} />;
    }
    return call.status === "running" ? (
      <Line icon={Upload} tone="running" text="Getting ready to push" />
    ) : (
      <Line icon={Upload} tone="quiet" text={answer?.note ?? "Pushed"} />
    );
  }
  return supersededBy(push, pushes) ? (
    <FoldedPush push={push} now={now} />
  ) : (
    <PushChecklist push={push} now={now} />
  );
}

const isLive = (push: PushRecord) =>
  push.stage === "checking" ||
  push.stage === "pushing" ||
  (push.stage === "pushed" &&
    (push.ci === undefined || push.ci.state === "waiting" || push.ci.state === "running"));

function ToneIcon({ tone, size = 14 }: { tone: Tone; size?: number }) {
  if (tone === "running") return <LoaderCircle size={size} className="shrink-0 animate-spin text-running" />;
  if (tone === "failed") return <X size={size} strokeWidth={2.25} className="shrink-0 text-error" />;
  if (tone === "passed") return <Check size={size} strokeWidth={2.25} className="shrink-0 text-success" />;
  return <Ban size={size - 1} strokeWidth={2} className="shrink-0 text-fg-tertiary" />;
}

/** A push that never got a record of its own: refused, or still asking. */
function Line({
  icon: Icon,
  tone,
  text,
  detail,
}: {
  icon: LucideIcon;
  tone: Tone;
  text: string;
  detail?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-meta text-fg-tertiary">
      {tone === "running" ? (
        <ToneIcon tone="running" size={13} />
      ) : (
        <Icon size={13} strokeWidth={1.75} className="shrink-0" />
      )}
      <span className="shrink-0 text-fg-secondary">{text}</span>
      {detail === undefined ? null : <span className="min-w-0 truncate">· {detail}</span>}
    </div>
  );
}

/** An older push, as one line that opens onto its checklist. */
function FoldedPush({ push, now }: { push: PushRecord; now: number }) {
  const { tone } = headline(push, now);
  return (
    <Collapsible.Root>
      <Collapsible.Trigger className="group flex max-w-full min-w-0 items-center gap-1.5 text-left text-meta text-fg-tertiary transition-colors hover:text-fg-secondary max-md:py-1">
        <ToneIcon tone={tone} size={13} />
        <span className="min-w-0 truncate">{foldedLine(push, now)}</span>
        <ChevronRight
          size={13}
          className="shrink-0 transition-transform duration-200 group-data-panel-open:rotate-90"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className={PANEL}>
        <div className="pt-2.5">
          <PushChecklist push={push} now={now} />
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function PushChecklist({ push, now }: { push: PushRecord; now: number }) {
  const { tone, title, meta, note } = headline(push, now);
  const checks = push.ci?.checks ?? [];
  // Before git sends anything, the checks on the user's computer are the checklist.
  const local = push.stage === "checking" || push.stage === "failed";
  return (
    <section
      aria-label="Push"
      className="overflow-hidden rounded-lg border border-line-subtle text-fg-primary"
    >
      <header className="flex min-h-9 items-center gap-2.5 py-1 pr-3 pl-3">
        <ToneIcon tone={tone} />
        <h3 className="min-w-0 truncate text-body font-medium">{title}</h3>
        {meta === undefined ? null : (
          <span className="ml-auto shrink-0 text-meta text-fg-tertiary tabular-nums">{meta}</span>
        )}
      </header>
      {note === undefined ? null : (
        <p className="-mt-1 px-3 pb-2 pl-[37px] text-meta text-fg-tertiary">{note}</p>
      )}
      {push.message !== undefined && push.stage !== "pushed" ? (
        <p className="-mt-1 px-3 pb-2 pl-[37px] text-meta text-fg-secondary">{push.message}</p>
      ) : null}
      {push.stage === "pushed" || push.stage === "rejected" ? <SentDetails push={push} now={now} /> : null}
      {local ? (
        <ul className="border-t border-line-subtle py-1">
          {push.hook.map((step, index) => (
            <StepRow key={`${step.label}:${index}`} step={step} now={now} />
          ))}
          <OutputRow output={push.output} open={push.stage === "failed" && push.hook.length === 0} />
        </ul>
      ) : null}
      {checks.length > 0 ? (
        <ul className="border-t border-line-subtle py-1">
          {checks.map((check) => (
            <CheckRow
              key={check.id}
              check={check}
              failure={push.ci?.failures.find((failure) => failure.checkId === check.id)}
              told={push.ci?.state === "failed"}
              now={now}
            />
          ))}
        </ul>
      ) : null}
      <Actions push={push} />
    </section>
  );
}

/** "Checked on your computer first, then sent to GitHub", opening onto those checks and the commits sent. */
function SentDetails({ push, now }: { push: PushRecord; now: number }) {
  return (
    <Collapsible.Root className="border-t border-line-subtle">
      <Collapsible.Trigger className="group flex h-8 w-full items-center gap-2.5 px-3 text-left text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary max-md:h-10">
        {push.stage === "rejected" ? (
          <X size={14} strokeWidth={2.25} className="shrink-0 text-error" />
        ) : (
          <Check size={14} strokeWidth={2.25} className="shrink-0 text-success" />
        )}
        <span className="min-w-0 truncate">
          {push.stage === "rejected" ? "Checked on your computer, but not sent" : sentLine(push)}
        </span>
        <ChevronRight
          size={13}
          className="ml-auto shrink-0 text-fg-tertiary opacity-0 transition-[opacity,rotate] duration-200 group-hover:opacity-100 group-data-panel-open:rotate-90 group-data-panel-open:opacity-100 pointer-coarse:opacity-100"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className={PANEL}>
        <div className="flex flex-col gap-1 pb-2">
          {push.hook.length === 0 ? null : (
            <ul>
              {push.hook.map((step, index) => (
                <StepRow key={`${step.label}:${index}`} step={step} now={now} quiet />
              ))}
            </ul>
          )}
          <ul>
            {push.commits.map((commit) => (
              <li key={commit.sha} className="flex h-7 min-w-0 items-center gap-2.5 px-3 pl-[37px] text-meta">
                <GitCommitHorizontal size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
                <span className="shrink-0 font-mono text-fg-tertiary">{commit.sha.slice(0, 7)}</span>
                <span className="min-w-0 truncate text-fg-secondary">{commit.subject}</span>
              </li>
            ))}
          </ul>
          {push.output.trim() === "" ? null : (
            <div className="px-3 pl-[37px]">
              <Log text={push.output} />
            </div>
          )}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function StateIcon({ state }: { state: PushCheck["state"] | HookStep["state"] }) {
  switch (state) {
    case "running":
      return <LoaderCircle size={14} className="shrink-0 animate-spin text-running" />;
    case "passed":
    case "done":
      return <Check size={14} strokeWidth={2.25} className="shrink-0 text-success" />;
    case "failed":
      return <X size={14} strokeWidth={2.25} className="shrink-0 text-error" />;
    case "cancelled":
    case "skipped":
      return <Ban size={13} strokeWidth={2} className="shrink-0 text-fg-tertiary" />;
    case "queued":
      return <Circle size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />;
    case "waiting":
      return <CircleDashed size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />;
  }
}

function Row({
  state,
  name,
  status,
  quiet = false,
}: {
  state: PushCheck["state"] | HookStep["state"];
  name: string;
  status: string;
  quiet?: boolean;
}) {
  const waiting = state === "waiting" || state === "queued" || state === "skipped" || state === "cancelled";
  return (
    <span
      className={`flex h-7 min-w-0 items-center gap-2.5 px-3 text-meta max-md:h-9 ${quiet ? "pl-[37px]" : ""}`}
    >
      <StateIcon state={state} />
      <span className={`min-w-0 truncate ${waiting || quiet ? "text-fg-tertiary" : "text-fg-primary"}`}>
        {name}
      </span>
      <span
        className={`ml-auto shrink-0 tabular-nums ${state === "failed" ? "text-error" : "text-fg-tertiary"}`}
      >
        {status}
      </span>
    </span>
  );
}

function StepRow({ step, now, quiet = false }: { step: HookStep; now: number; quiet?: boolean }) {
  return (
    <li>
      <Row state={step.state} name={step.label} status={stepStatus(step, now)} quiet={quiet} />
    </li>
  );
}

/** What the checks on the user's computer printed, under their steps. */
function OutputRow({ output, open: initiallyOpen }: { output: string; open: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  if (output.trim() === "") return null;
  return (
    <li>
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger className="flex h-7 items-center px-3 pl-[37px] text-meta text-fg-tertiary transition-colors hover:text-fg-primary max-md:h-9">
          {open ? "Hide output" : "Show output"}
        </Collapsible.Trigger>
        <Collapsible.Panel className={PANEL}>
          <div className="px-3 pb-2 pl-[37px]">
            <Log text={output} />
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </li>
  );
}

function CheckRow({
  check,
  failure,
  told,
  now,
}: {
  check: PushCheck;
  failure: CheckFailure | undefined;
  /** CI ended, so the agent has been given this failure. */
  told: boolean;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const row = <Row state={check.state} name={check.name} status={checkStatus(check, now)} />;
  if (check.state !== "failed") return <li>{row}</li>;
  const why =
    failure?.summary ??
    (check.failedStep === undefined ? "It failed." : `It failed at "${check.failedStep}".`);
  return (
    <li className="bg-error/5">
      {row}
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <p className="-mt-1 flex min-w-0 flex-wrap items-baseline gap-x-1.5 px-3 pb-2 pl-[37px] text-meta text-fg-secondary">
          <span className="min-w-0 break-words">
            {sentence(why)}
            {told ? " The agent has the error." : ""}
          </span>
          {failure !== undefined && failure.log !== "" ? (
            <Collapsible.Trigger className="text-fg-primary underline decoration-line-strong underline-offset-2 transition-colors hover:decoration-fg-primary">
              {open ? "Hide error" : "Show error"}
            </Collapsible.Trigger>
          ) : null}
        </p>
        <Collapsible.Panel className={PANEL}>
          <div className="px-3 pb-2.5 pl-[37px]">
            <Log text={failure?.log ?? ""} failed />
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </li>
  );
}

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

function Log({ text, failed = false }: { text: string; failed?: boolean }) {
  return (
    <pre
      className={`scroll-thin max-h-72 overflow-auto rounded-md border bg-surface-window px-3 py-2 font-mono text-meta leading-relaxed break-words whitespace-pre-wrap text-fg-secondary select-text ${failed ? "border-error/30" : "border-line-subtle"}`}
    >
      {text.replace(/\n+$/, "")}
    </pre>
  );
}

/** What the user can do with the checks: see them on GitHub, run the failed ones again, stop them, or hand them to the agent. */
function Actions({ push }: { push: PushRecord }) {
  const act = useAtomSet(pushAction, { mode: "promise" });
  const [busy, setBusy] = useState<PushAction>();
  const [error, setError] = useState<string>();
  const ci = push.ci;
  const url = runUrl(push);
  const state = ci?.state;
  const failed = state === "failed";
  const running = state === "running" || state === "waiting";
  if (url === undefined && !failed && !running) return null;

  const run = async (action: PushAction) => {
    setBusy(action);
    setError(undefined);
    try {
      await act({ payload: { pushId: push.id, action } });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <footer className="flex flex-wrap items-center gap-0.5 border-t border-line-subtle px-1.5 py-1">
      {url === undefined ? null : (
        <ActionButton icon={ExternalLink} onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
          Open on GitHub
        </ActionButton>
      )}
      {failed ? (
        <>
          <ActionButton
            icon={RotateCcw}
            busy={busy === "rerunFailed"}
            onClick={() => void run("rerunFailed")}
          >
            Re-run failed
          </ActionButton>
          <ActionButton
            icon={MessageSquareShare}
            busy={busy === "sendToAgent"}
            onClick={() => void run("sendToAgent")}
          >
            Send to agent
          </ActionButton>
        </>
      ) : null}
      {running && (ci?.runs.length ?? 0) > 0 ? (
        <ActionButton icon={Ban} busy={busy === "cancel"} onClick={() => void run("cancel")}>
          Cancel
        </ActionButton>
      ) : null}
      {error === undefined ? null : (
        <span className="min-w-0 truncate px-2 text-meta text-error">{error}</span>
      )}
    </footer>
  );
}

const messageOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
    ? cause.message
    : "That didn't work.";

function ActionButton({
  icon: Icon,
  busy = false,
  onClick,
  children,
}: {
  icon: LucideIcon;
  busy?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      onClick={onClick}
      disabled={busy}
      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-meta text-fg-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-primary disabled:opacity-60 max-md:h-9"
    >
      {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Icon size={13} strokeWidth={1.75} />}
      {children}
    </Button>
  );
}
