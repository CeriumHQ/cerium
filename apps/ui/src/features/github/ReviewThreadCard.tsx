import { Button } from "@base-ui/react/button";
import type { DiffHunk, ReviewThread } from "@cerium/rpc";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { DialogButton } from "../../components/ui/FormDialog.tsx";
import { keyLabel } from "../../lib/keys.ts";
import { Markdown } from "../transcript/Markdown.tsx";
import { numberHunks } from "../viewer/model.ts";
import { Avatar, loginOf, Reactions, When } from "./parts.tsx";
import type { PullActions } from "./usePullRequest.ts";

/** How many of the diff's lines a thread shows above its comments, ending with the line it's on. */
const SNIPPET_LINES = 4;

const tint = { context: "", removed: "bg-error/10", added: "bg-success/10" } as const;
const marker = { context: " ", removed: "−", added: "+" } as const;

/**
 * A review thread: where in the diff it is, what was said there, and the box to reply in. A resolved
 * or outdated thread shows folded, as GitHub's conversation shows it.
 */
export function ReviewThreadCard({
  thread,
  actions,
  snippet = true,
}: {
  thread: ReviewThread;
  actions: PullActions;
  /** Shows its file and the lines it's on; within the file's own diff, only the line number. */
  snippet?: boolean;
}) {
  const [open, setOpen] = useState(!thread.resolved && !thread.outdated);
  const line = thread.line ?? thread.originalLine;
  return (
    <section className="overflow-hidden rounded-xl border border-line-subtle bg-surface-raised font-sans">
      <Button
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left text-meta transition-colors hover:bg-surface-hover"
      >
        <ChevronRight
          size={13}
          strokeWidth={2}
          className={`shrink-0 text-fg-tertiary transition-transform duration-200 ease-out-soft motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
        {snippet ? (
          <span
            className="min-w-0 truncate font-mono text-meta text-fg-secondary [direction:rtl]"
            title={thread.path}
          >
            {/* The right-to-left run keeps the file's name in view as the folders give way. */}
            <bdi>{thread.path}</bdi>
          </span>
        ) : null}
        {line === undefined ? null : (
          <span
            className={`shrink-0 text-meta tabular-nums ${snippet ? "text-fg-tertiary" : "text-fg-secondary"}`}
          >
            {thread.startLine !== undefined && thread.startLine !== line
              ? `Lines ${thread.startLine}–${line}`
              : `Line ${line}`}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {thread.outdated ? <Badge>Outdated</Badge> : null}
          {thread.resolved ? <Badge>Resolved</Badge> : null}
          {open ? null : (
            <span className="text-meta text-fg-tertiary tabular-nums">
              {thread.comments.length === 1 ? "1 comment" : `${thread.comments.length} comments`}
            </span>
          )}
        </span>
      </Button>
      {open ? (
        <div className="border-t border-line-subtle">
          {snippet && thread.hunk ? <Snippet hunk={thread.hunk} /> : null}
          <ol className="flex flex-col">
            {thread.comments.map((comment) => (
              <li key={comment.id} className="flex gap-2.5 border-line-subtle px-3 py-2.5 not-first:border-t">
                <Avatar user={comment.author} size={20} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="flex flex-wrap items-center gap-x-1.5 text-meta">
                    <span className="font-medium text-fg-primary">{loginOf(comment.author)}</span>
                    <When at={comment.at} className="text-fg-tertiary" />
                    {comment.edited === undefined ? null : <span className="text-fg-tertiary">· edited</span>}
                  </p>
                  {comment.hidden === undefined ? (
                    <Markdown text={comment.body} streaming={false} compact />
                  ) : (
                    <p className="text-meta text-fg-tertiary italic">
                      Hidden as {comment.hidden.toLowerCase()}.
                    </p>
                  )}
                  <Reactions reactions={comment.reactions} />
                </div>
              </li>
            ))}
          </ol>
          <ThreadFooter thread={thread} actions={actions} />
        </div>
      ) : null}
    </section>
  );
}

function Badge({ children }: { children: string }) {
  return (
    <span className="inline-flex h-[18px] items-center rounded-full border border-line-subtle px-1.5 text-caption text-fg-tertiary">
      {children}
    </span>
  );
}

/** The last lines of the diff a thread was written on, ending with its line. */
function Snippet({ hunk }: { hunk: DiffHunk }) {
  const lines = numberHunks([hunk]).hunks[0]?.lines.slice(-SNIPPET_LINES) ?? [];
  if (lines.length === 0) return null;
  return (
    <div className="overflow-x-auto border-b border-line-subtle font-mono text-meta leading-[1.6]">
      {lines.map((line, index) => (
        <div key={index} className={`flex w-max min-w-full ${tint[line.kind]}`}>
          <span className="w-10 shrink-0 px-2 text-right text-fg-disabled tabular-nums select-none">
            {line.old ?? ""}
          </span>
          <span className="w-10 shrink-0 px-2 text-right text-fg-disabled tabular-nums select-none">
            {line.new ?? ""}
          </span>
          <span className="w-4 shrink-0 text-fg-disabled select-none">{marker[line.kind]}</span>
          <span className="pr-4 whitespace-pre text-fg-primary">{line.text === "" ? " " : line.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Replying to a thread, and resolving it or opening it again. */
function ThreadFooter({ thread, actions }: { thread: ReviewThread; actions: PullActions }) {
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const busy = actions.busy !== undefined;
  const reply = async () => {
    if (text.trim() === "") return;
    if (await actions.reply(thread.id, text.trim())) {
      setText("");
      setWriting(false);
    }
  };
  const resolve = thread.canResolve ? (
    <DialogButton onClick={() => void actions.resolve(thread.id, !thread.resolved)} disabled={busy}>
      {actions.busy === "resolve" ? "Saving…" : thread.resolved ? "Unresolve" : "Resolve"}
    </DialogButton>
  ) : null;

  if (!thread.canReply) {
    return resolve === null ? null : (
      <div className="flex justify-end border-t border-line-subtle px-3 py-2">{resolve}</div>
    );
  }
  if (!writing) {
    return (
      <div className="flex items-center gap-2 border-t border-line-subtle px-3 py-2">
        <Button
          onClick={() => setWriting(true)}
          className="flex h-8 min-w-0 flex-1 items-center rounded-lg border border-line-subtle bg-surface-window px-2.5 text-left text-meta text-fg-tertiary transition-colors hover:border-line-strong"
        >
          Reply…
        </Button>
        {resolve}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 border-t border-line-subtle px-3 py-2.5">
      <textarea
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the box opens because the user asked to reply
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void reply();
          } else if (event.key === "Escape" && text === "") {
            event.preventDefault();
            setWriting(false);
          }
        }}
        placeholder="Reply"
        aria-label="Reply"
        spellCheck
        disabled={actions.busy === "reply"}
        className="max-h-60 min-h-16 w-full resize-none rounded-lg border border-line-strong bg-transparent px-2.5 py-2 text-body leading-relaxed text-fg-primary outline-none [field-sizing:content] placeholder:text-fg-tertiary focus-visible:border-fg-tertiary disabled:opacity-60"
      />
      {actions.error === undefined || actions.busy !== undefined ? null : (
        <p role="alert" className="text-meta text-error-text">
          {actions.error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {resolve}
        <DialogButton onClick={() => setWriting(false)} disabled={actions.busy === "reply"}>
          Cancel
        </DialogButton>
        <DialogButton
          tone="primary"
          onClick={() => void reply()}
          disabled={busy || text.trim() === ""}
          title={`Reply (${keyLabel("Ctrl Enter")})`}
        >
          {actions.busy === "reply" ? "Replying…" : "Reply"}
        </DialogButton>
      </div>
    </div>
  );
}
