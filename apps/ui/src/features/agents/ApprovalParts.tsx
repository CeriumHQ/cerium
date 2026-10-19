import { Button } from "@base-ui/react/button";

import { Disclosure } from "../../components/ui/Disclosure.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import type { PermissionAnswer } from "../transcript/Blocks.tsx";
import { fileEdits } from "../transcript/diff.ts";
import { EditDiff } from "../transcript/EditDiff.tsx";

// The pieces every approval card is made of, so the transcript's card for the lead's own requests
// and the tray's cards for the others' say the same things the same way.

/** The card a request waits in. */
export const approvalShell =
  "flex flex-col gap-2.5 rounded-lg border border-attention/35 bg-surface-raised p-3 shadow-raised";

/** The chords that answer the request at the front of the tray. */
export const answerKeys = { allow: "Alt Y", session: "Alt S", deny: "Alt N" } as const;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const textOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** A command as one string; harnesses send it as text or as the words of it. */
const commandOf = (value: unknown): string | undefined =>
  Array.isArray(value) && value.every((word) => typeof word === "string") ? value.join(" ") : textOf(value);

/** A path that breaks after its separators, so a long one wraps between folders, not mid-name. */
function PathText({ path }: { path: string }) {
  return (
    <span className="font-mono text-xs break-words text-fg-tertiary">
      {path.split(/(?<=[\\/])/).map((part, index) => (
        <span key={index}>
          {part}
          <wbr />
        </span>
      ))}
    </span>
  );
}

/** What fits on a line or two reads inline; anything longer folds. */
const INLINE_LIMIT = 240;

const detailBox =
  "rounded-md border border-line-subtle bg-surface-window px-2.5 py-1.5 font-mono text-[12px] leading-[1.55] text-fg-primary select-text";

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
      <div className="rounded-md border border-line-subtle bg-surface-window py-1.5 font-mono text-[12px] leading-[1.6] select-text">
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

/**
 * What the agent is asking to do, as exactly as the harness said it: the command, the edit's diff
 * with the file it changes, or else its raw input, folded when it's long.
 */
export function ApprovalDetail({ input }: { input: unknown }) {
  const fields = record(input);
  const command = commandOf(fields?.["command"]);
  if (command !== undefined) return <Wrapped>{command}</Wrapped>;

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

  if (input === undefined || input === null || (fields !== undefined && Object.keys(fields).length === 0)) {
    return null;
  }
  const raw = JSON.stringify(input, null, 2) ?? "";
  if (raw.length <= INLINE_LIMIT) return <Wrapped>{raw}</Wrapped>;
  return (
    <Disclosure
      summary="Details"
      hint={
        fields ? Object.keys(fields).join(", ") : Array.isArray(input) ? `${input.length} items` : undefined
      }
    >
      <Wrapped>{raw}</Wrapped>
    </Disclosure>
  );
}

/** Plain text under a title, such as the prompt a lead gave an agent it asks to start. */
export function ApprovalText({ children }: { children: string }) {
  return <Wrapped>{children}</Wrapped>;
}

const base =
  "h-7 rounded-md px-2 text-[12.5px] transition-colors max-md:h-9 max-md:px-3.5 max-md:text-[13px]";
const primary = `${base} bg-accent font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80`;
const outlined = `${base} border border-line-strong font-medium text-fg-primary hover:bg-surface-hover`;
const quiet = `${base} ml-auto text-fg-secondary hover:bg-surface-hover hover:text-fg-primary`;

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
 * Allow once, allow for the rest of the session, or deny; a request that has no session to carry the
 * answer over (starting an agent) offers allow and deny. `keys` names the chords that answer it.
 */
export function ApprovalActions({
  onAnswer,
  session = true,
  keys = false,
}: {
  onAnswer?: PermissionAnswer | undefined;
  session?: boolean;
  keys?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Answer
        label={session ? "Allow once" : "Allow"}
        chord={keys ? answerKeys.allow : undefined}
        className={primary}
        onClick={() => onAnswer?.("allow", "once")}
      />
      {session ? (
        <Answer
          label="Allow for session"
          chord={keys ? answerKeys.session : undefined}
          className={outlined}
          onClick={() => onAnswer?.("allow", "session")}
        />
      ) : null}
      <Answer
        label="Deny"
        chord={keys ? answerKeys.deny : undefined}
        className={quiet}
        onClick={() => onAnswer?.("deny", "once")}
      />
    </div>
  );
}
