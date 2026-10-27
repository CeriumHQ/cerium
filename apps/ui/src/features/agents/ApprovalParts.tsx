import { Button } from "@base-ui/react/button";
import {
  Download,
  FilePen,
  FilePlus,
  FileSearch,
  GitCommitHorizontal,
  Globe,
  Plug,
  ShieldAlert,
  SquareTerminal,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Disclosure } from "../../components/ui/Disclosure.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import type { PermissionAnswer } from "../transcript/Blocks.tsx";
import { fileEdits } from "../transcript/diff.ts";
import { EditDiff } from "../transcript/EditDiff.tsx";
import {
  allowsSession,
  commandOf,
  explainRequest,
  type Effect,
  type EffectKind,
  type RequestLike,
  type Risk,
} from "./explain.ts";

// The pieces every approval card is made of, so the transcript's card for the lead's own requests
// and the tray's cards for the others' say the same things the same way.

/** The card a request waits in. Colour is kept for what is risky, not for asking. */
export const approvalShell =
  "flex flex-col gap-2.5 rounded-lg border border-line-subtle bg-surface-raised p-3 shadow-raised";

/** The chords that answer the request at the front of the tray. */
export const answerKeys = { allow: "Alt Y", session: "Alt S", deny: "Alt N" } as const;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const textOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** A path that breaks after its separators, so a long one wraps between folders, not mid-name. */
function PathText({ path }: { path: string }) {
  return (
    <span className="font-mono text-meta break-words text-fg-tertiary">
      {path.split(/(?<=[\\/])/).map((part, index) => (
        <span key={index}>
          {part}
          <wbr />
        </span>
      ))}
    </span>
  );
}

const detailBox =
  "rounded-md border border-line-subtle bg-surface-window px-2.5 py-1.5 font-mono text-meta leading-[1.55] text-fg-primary select-text";

/** Wraps rather than scrolls sideways: the whole command is what's being approved. */
function Wrapped({ children }: { children: string }) {
  return (
    <pre className={`${detailBox} max-h-[min(10rem,24vh)] overflow-y-auto break-words whitespace-pre-wrap`}>
      {children}
    </pre>
  );
}

/** A patch's lines as the harness wrote them, tinted like a diff. */
function PatchDiff({ path, kind, diff }: { path: string; kind: string; diff: string }) {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const tone = (line: string) =>
    kind === "add" || (kind !== "delete" && line.startsWith("+") && !line.startsWith("+++"))
      ? "bg-success/10 text-fg-primary"
      : kind === "delete" || (line.startsWith("-") && !line.startsWith("---"))
        ? "bg-error/10 text-fg-primary"
        : "text-fg-tertiary";
  return (
    <div className="flex flex-col gap-1">
      <PathText path={path} />
      <div className="rounded-md border border-line-subtle bg-surface-window py-1.5 font-mono text-meta leading-[1.6] select-text">
        <div className="grid w-max min-w-full">
          {lines.map((line, index) => (
            <div key={index} className={`px-2.5 whitespace-pre ${tone(line)}`}>
              {line === "" ? " " : line}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const patchesOf = (input: unknown) => {
  const changes = record(input)?.["changes"];
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((change: unknown) => {
    const fields = record(change);
    const path = textOf(fields?.["path"]);
    const diff = textOf(fields?.["diff"]);
    return path !== undefined && diff !== undefined
      ? [{ path, diff, kind: textOf(record(fields?.["kind"])?.["type"]) ?? "update" }]
      : [];
  });
};

const isEmpty = (input: unknown) =>
  input === undefined ||
  input === null ||
  (record(input) !== undefined && Object.keys(record(input)!).length === 0);

/**
 * What the agent is asking to do, as exactly as the harness said it: the command, the edit's diff
 * with the file it changes, or else its raw input.
 */
export function ApprovalDetail({ input }: { input: unknown }) {
  const command = commandOf(input);
  if (command !== undefined) return <Wrapped>{command}</Wrapped>;

  const fields = record(input);
  const edits = fileEdits(input);
  if (edits.length > 0) {
    const path = textOf(fields?.["file_path"]) ?? textOf(fields?.["path"]);
    return (
      <div className="flex flex-col gap-1">
        {path ? <PathText path={path} /> : null}
        <EditDiff edits={edits} />
      </div>
    );
  }

  const patches = patchesOf(input);
  if (patches.length > 0) {
    return (
      <div className="flex max-h-[min(16rem,32vh)] flex-col gap-2 overflow-auto">
        {patches.map((patch) => (
          <PatchDiff key={patch.path} {...patch} />
        ))}
      </div>
    );
  }

  if (isEmpty(input)) return null;
  return <Wrapped>{JSON.stringify(input, null, 2) ?? ""}</Wrapped>;
}

/** How the folded detail is named, with what it holds at a glance. */
const detailLabel = (input: unknown): { summary: string; hint: string | undefined } | undefined => {
  const command = commandOf(input);
  if (command !== undefined) return { summary: "Command", hint: command.replace(/\s+/g, " ") };
  const fields = record(input);
  if (fileEdits(input).length > 0) {
    return { summary: "Change", hint: textOf(fields?.["file_path"]) ?? textOf(fields?.["path"]) };
  }
  const patches = patchesOf(input);
  if (patches.length > 0) return { summary: "Changes", hint: patches.map((patch) => patch.path).join(", ") };
  if (isEmpty(input)) return undefined;
  return {
    summary: "Details",
    hint: fields
      ? Object.keys(fields).join(", ")
      : Array.isArray(input)
        ? `${input.length} items`
        : undefined,
  };
};

/** The exact command or change, folded under the plain words until asked for. */
function ExactDetail({ input }: { input: unknown }) {
  const label = detailLabel(input);
  if (label === undefined) return null;
  return (
    <Disclosure summary={label.summary} hint={label.hint}>
      <ApprovalDetail input={input} />
    </Disclosure>
  );
}

/** Plain text under a title, such as the prompt a lead gave an agent it asks to start. */
export function ApprovalText({ children }: { children: string }) {
  return <Wrapped>{children}</Wrapped>;
}

/** What a request asks for, in a line, and why the agent asks when it said. */
export function RequestHeadline({ headline, why }: { headline: ReactNode; why?: string | undefined }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className="line-clamp-3 text-reading leading-[1.4] font-semibold break-words text-fg-primary select-text max-md:text-[15px]">
        {headline}
      </p>
      {why ? (
        <p className="line-clamp-3 text-body leading-[1.5] break-words text-fg-secondary select-text max-md:text-[14px]">
          {why}
        </p>
      ) : null}
    </div>
  );
}

const riskName: Record<Risk, string> = { low: "Low risk", some: "Some risk", high: "High risk" };
const riskBars: Record<Risk, number> = { low: 1, some: 2, high: 3 };

const effectIcon: Record<EffectKind, LucideIcon> = {
  read: FileSearch,
  edit: FilePen,
  create: FilePlus,
  delete: Trash2,
  run: SquareTerminal,
  download: Download,
  network: Globe,
  upload: Upload,
  history: GitCommitHorizontal,
  admin: ShieldAlert,
  tool: Plug,
};

/** How risky a request is, as a meter of three bars and its name, then what it would change. */
function RiskFacts({ risk, effects }: { risk: Risk; effects: ReadonlyArray<Effect> }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-meta text-fg-tertiary max-md:text-[13px]">
      <li
        className={`flex items-center gap-1.5 font-medium ${risk === "high" ? "text-error-text" : "text-fg-primary"}`}
      >
        <span aria-hidden className="flex items-end gap-[2px]">
          {[6, 9, 12].map((height, index) => (
            <span
              key={height}
              style={{ height }}
              className={`w-[3px] rounded-[1px] ${index < riskBars[risk] ? "bg-current" : "bg-line-strong"}`}
            />
          ))}
        </span>
        {riskName[risk]}
      </li>
      {effects.map((effect) => {
        const Icon = effectIcon[effect.kind];
        return (
          <li key={effect.text} className="flex min-w-0 items-center gap-1.5">
            <Icon size={13} strokeWidth={1.75} className="shrink-0" />
            <span className="truncate">{effect.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A permission request explained: what the agent wants and why, how risky it is and what it would
 * change, the exact command or change folded underneath, and the answers. A high-risk request is
 * answered once at a time, never for the rest of the chat.
 */
export function PermissionPrompt({
  request,
  from,
  keys,
  onAnswer,
}: {
  request: RequestLike;
  /** Who is asking, when it isn't the agent whose transcript this is. */
  from?: ReactNode;
  keys: boolean;
  onAnswer?: PermissionAnswer | undefined;
}) {
  const { headline, why, risk, effects } = explainRequest(request);
  return (
    <div className={approvalShell}>
      {from}
      <RequestHeadline headline={headline} why={why} />
      <RiskFacts risk={risk} effects={effects} />
      <ExactDetail input={request.input} />
      <ApprovalActions
        onAnswer={onAnswer}
        session={allowsSession(risk)}
        risky={risk === "high"}
        keys={keys}
      />
    </div>
  );
}

const base = "h-7 rounded-md px-2.5 text-meta transition-colors max-md:h-9 max-md:px-3.5 max-md:text-[13px]";
/** The answer buttons' looks: the answer most give, another one, and the one that turns it away. */
export const primary = `${base} bg-accent font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80 disabled:pointer-events-none disabled:opacity-40`;
const outlined = `${base} border border-line-strong font-medium text-fg-primary hover:bg-surface-hover`;
/** Allowing what can't be undone: outlined in the error colour rather than filled, so it reads as a choice. */
const riskyAnswer = `${base} border border-error/55 font-medium text-error-text hover:bg-error/10`;
export const quiet = `${base} ml-auto text-fg-secondary hover:bg-surface-hover hover:text-fg-primary disabled:pointer-events-none disabled:opacity-40`;

/** An answer button, naming the chord that gives the same answer where there is one. */
function Answer({
  label,
  chord,
  className,
  onClick,
}: {
  label: string;
  chord: string | undefined;
  className: string;
  onClick: () => void;
}) {
  const button = (
    <Button
      onClick={onClick}
      className={className}
      {...(chord ? { "aria-keyshortcuts": chord.replace(" ", "+") } : {})}
    >
      {label}
    </Button>
  );
  return chord ? (
    <Tooltip label={label} shortcut={chord} side="top">
      {button}
    </Tooltip>
  ) : (
    button
  );
}

/**
 * Allow once, allow for the rest of the chat, or don't; a request with no chat to carry the answer
 * over (starting an agent) or too risky to (deleting files) offers allow and don't. `keys` names the
 * chords that answer it.
 */
export function ApprovalActions({
  onAnswer,
  session = true,
  risky = false,
  keys = false,
}: {
  onAnswer?: PermissionAnswer | undefined;
  session?: boolean;
  /** What's allowed can't be undone, so allowing it doesn't look like the usual answer. */
  risky?: boolean;
  keys?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Answer
        label="Allow"
        chord={keys ? answerKeys.allow : undefined}
        className={risky ? riskyAnswer : primary}
        onClick={() => onAnswer?.("allow", "once")}
      />
      {session ? (
        <Answer
          label="Allow for this chat"
          chord={keys ? answerKeys.session : undefined}
          className={outlined}
          onClick={() => onAnswer?.("allow", "session")}
        />
      ) : null}
      <Answer
        label="Don't allow"
        chord={keys ? answerKeys.deny : undefined}
        className={quiet}
        onClick={() => onAnswer?.("deny", "once")}
      />
    </div>
  );
}
