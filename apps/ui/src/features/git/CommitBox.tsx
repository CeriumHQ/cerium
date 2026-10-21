import type { MadeCommit } from "@cerium/rpc";
import { Button } from "@base-ui/react/button";
import { Checkbox } from "@base-ui/react/checkbox";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { Check, GitCommitHorizontal } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { commitChanges, lastCommitMessage } from "../../backend/git.ts";
import { Disclosure } from "../../components/ui/Disclosure.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { commitDraftAtom, commitMessage, splitMessage } from "./model.ts";

/** A failure as the box shows it: git's reason, and what it or a hook printed. */
interface Failure {
  readonly message: string;
  readonly output?: string | undefined;
}

const failureOf = (error: unknown): Failure => {
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  return {
    message: typeof record["message"] === "string" ? record["message"] : "Git couldn't make the commit.",
    output: typeof record["output"] === "string" ? record["output"] : undefined,
  };
};

const fieldClass =
  "w-full bg-transparent px-3 text-[13px] text-fg-primary outline-none placeholder:text-fg-tertiary max-md:text-[15px]";

/**
 * The next commit's message and the button that makes it, above the lists: what's staged goes in, or
 * everything when nothing is. Amend rewrites the last commit, its message filled in to edit. A commit
 * a hook stops says so, with what the hook printed.
 */
export function CommitBox({
  top,
  staged,
  changed,
  conflicted,
  onCommitted,
}: {
  /** The repository's top. */
  top: string;
  /** How many files are staged, aren't, and are conflicted. */
  staged: number;
  changed: number;
  conflicted: number;
  /** Has what the panel shows read again. */
  onCommitted: () => void;
}) {
  const [draft, setDraft] = useAtom(commitDraftAtom(top));
  const commit = useAtomSet(commitChanges, { mode: "promise" });
  const readLast = useAtomSet(lastCommitMessage, { mode: "promise" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure>();
  const [made, setMade] = useState<MadeCommit>();
  /** The message amending filled in, taken out again if the user turns amending off untouched. */
  const [filled, setFilled] = useState<string>();

  const message = commitMessage(draft.subject, draft.body);
  const all = staged === 0 && changed > 0 && !draft.amend;
  const blocked =
    conflicted > 0
      ? "Settle the conflicts first."
      : !draft.amend && staged + changed === 0
        ? "Nothing to commit."
        : undefined;
  const ready = !busy && blocked === undefined && (draft.amend || draft.subject.trim() !== "");

  const edit = (next: Partial<typeof draft>) => {
    setDraft({ ...draft, ...next });
    setFailure(undefined);
    setMade(undefined);
  };

  const toggleAmend = async (amend: boolean) => {
    edit({ amend });
    if (!amend) {
      if (filled !== undefined && message === filled) setDraft({ subject: "", body: "", amend: false });
      setFilled(undefined);
      return;
    }
    if (message !== "") return;
    try {
      const last = await readLast({ payload: { root: top } });
      setDraft({ ...splitMessage(last.message), amend: true });
      setFilled(commitMessage(splitMessage(last.message).subject, splitMessage(last.message).body));
    } catch {
      // Without the old message the user writes a new one.
    }
  };

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await commit({
        payload: {
          root: top,
          message,
          ...(draft.amend ? { amend: true } : {}),
          ...(all ? { all: true } : {}),
        },
      });
      setDraft({ subject: "", body: "", amend: false });
      setFilled(undefined);
      setMade(result);
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
      onCommitted();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const label = busy
    ? draft.amend
      ? "Amending…"
      : "Committing…"
    : draft.amend
      ? "Amend last commit"
      : all
        ? "Stage all and commit"
        : staged === 0
          ? "Commit"
          : staged === 1
            ? "Commit 1 file"
            : `Commit ${staged} files`;

  return (
    <div className="flex flex-col gap-2 border-b border-line-subtle p-2">
      <div className="flex flex-col rounded-xl border border-line-subtle bg-surface-raised transition-colors focus-within:border-line-strong">
        <input
          value={draft.subject}
          onChange={(event) => edit({ subject: event.currentTarget.value })}
          onKeyDown={onKeyDown}
          placeholder={draft.amend ? "Message of the last commit" : "Message"}
          aria-label="Commit message"
          spellCheck
          className={`${fieldClass} h-9 max-md:h-11`}
        />
        {draft.subject !== "" || draft.body !== "" ? (
          <textarea
            value={draft.body}
            onChange={(event) => edit({ body: event.currentTarget.value })}
            onKeyDown={onKeyDown}
            placeholder="Description"
            aria-label="Commit description"
            rows={2}
            spellCheck
            className={`${fieldClass} scroll-thin field-sizing-content max-h-48 min-h-12 resize-none border-t border-line-subtle py-2 leading-relaxed`}
          />
        ) : null}
        <div className="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
          <Checkbox.Root
            checked={draft.amend}
            onCheckedChange={(checked) => void toggleAmend(checked)}
            className="group flex cursor-default items-center gap-1.5 rounded-md text-left text-[12px] text-fg-tertiary outline-none select-none hover:text-fg-secondary data-checked:text-fg-secondary max-md:text-[14px]"
          >
            <span className="grid size-3.5 shrink-0 place-items-center rounded-[4px] border border-line-strong transition-colors group-focus-visible:border-fg-secondary group-data-checked:border-accent group-data-checked:bg-accent">
              <Checkbox.Indicator className="text-accent-fg data-unchecked:hidden">
                <Check size={10} strokeWidth={3} />
              </Checkbox.Indicator>
            </span>
            Amend
          </Checkbox.Root>
          <Tooltip
            label={
              blocked ??
              (draft.amend
                ? "Rewrites the last commit with what's staged and this message"
                : all
                  ? "Stages every change, then commits them"
                  : "Commits what's staged")
            }
            {...(blocked === undefined ? { shortcut: "Ctrl Enter" } : {})}
          >
            <Button
              onClick={() => void submit()}
              disabled={!ready}
              focusableWhenDisabled
              className="ml-auto flex h-7 min-w-0 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[12.5px] font-medium text-accent-fg transition-colors hover:bg-accent-strong data-disabled:cursor-default data-disabled:bg-surface-active data-disabled:text-fg-disabled max-md:h-10 max-md:text-[15px]"
            >
              <GitCommitHorizontal size={14} strokeWidth={1.75} className="shrink-0" />
              <span className="truncate">{label}</span>
            </Button>
          </Tooltip>
        </div>
      </div>
      {failure ? (
        <div role="alert" className="flex flex-col gap-1">
          <p className="text-[12.5px] text-error max-md:text-[14px]">{failure.message}</p>
          {failure.output === undefined ? null : (
            <Disclosure
              summary={/hook/.test(failure.message) ? "What the hook printed" : "What git printed"}
              defaultOpen={/hook/.test(failure.message)}
            >
              <pre className="scroll-thin max-h-56 overflow-auto rounded-lg bg-surface-sunken p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-secondary">
                {failure.output}
              </pre>
            </Disclosure>
          )}
        </div>
      ) : made ? (
        <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-fg-tertiary max-md:text-[14px]">
          <Check size={13} strokeWidth={2} className="shrink-0 text-success" />
          <span className="shrink-0 font-mono">{made.commit}</span>
          <span className="min-w-0 truncate">{made.subject}</span>
        </p>
      ) : null}
    </div>
  );
}
