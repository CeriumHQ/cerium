import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button } from "@base-ui/react/button";
import type { RestorePreview } from "@cerium/protocol";
import { Bot, FileClock, History, MessageSquareX, TriangleAlert, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Disclosure } from "../../components/ui/Disclosure.tsx";
import { agentsLine, conversationLine, filesLine, messagesLine, undoLabel } from "./restore.ts";

/** What a restore would undo, while it is read. */
export type RestoreCheck =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly preview: RestorePreview }
  | { readonly status: "failed"; readonly message: string };

function Line({ icon: Icon, tone, children }: { icon: LucideIcon; tone?: "warning"; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <Icon
        size={14}
        strokeWidth={1.75}
        className={`mt-[3px] shrink-0 ${tone === "warning" ? "text-warning" : "text-fg-tertiary"}`}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/** A folded list of files, each with a quiet note beside it. */
function FileList({
  summary,
  files,
}: {
  summary: string;
  files: ReadonlyArray<{ readonly path: string; readonly note: string }>;
}) {
  return (
    <Disclosure summary={summary}>
      <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto pr-1">
        {files.map((file) => (
          <li key={file.path} className="flex items-baseline gap-2 text-[12.5px]">
            <span className="min-w-0 flex-1 truncate font-mono text-fg-secondary" title={file.path}>
              {file.path}
            </span>
            <span className="shrink-0 text-fg-tertiary">{file.note}</span>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

function Consequences({ preview, harness }: { preview: RestorePreview; harness: string }) {
  const { files } = preview;
  return (
    <ul className="flex flex-col gap-2.5 text-[13px] leading-snug text-fg-primary">
      <Line icon={MessageSquareX}>{messagesLine(preview.messages)}</Line>
      <Line icon={History}>{conversationLine(preview.conversation, harness)}</Line>
      {preview.agents.length > 0 ? <Line icon={Bot}>{agentsLine(preview.agents)}</Line> : null}
      {files === undefined ? null : (
        <Line icon={FileClock}>
          <p className={"unavailable" in files ? "text-fg-secondary" : undefined}>{filesLine(files)}</p>
          {"restored" in files && files.restored.length > 0 ? (
            <FileList
              summary={files.restored.length === 1 ? "Which file" : "Which files"}
              files={files.restored.map((file) => ({ path: file.path, note: undoLabel[file.undo] }))}
            />
          ) : null}
        </Line>
      )}
      {files !== undefined && "kept" in files && files.kept.length > 0 ? (
        <Line icon={TriangleAlert} tone="warning">
          <p>
            Leaves {files.kept.length === 1 ? "1 file" : `${files.kept.length} files`} another thread changed
            too
          </p>
          <FileList
            summary={files.kept.length === 1 ? "Which file" : "Which files"}
            files={files.kept.map((file) => ({ path: file.path, note: file.thread }))}
          />
        </Line>
      ) : null}
    </ul>
  );
}

/**
 * Asks before restoring a thread to before one of the user's messages, saying what it undoes: the
 * messages, the conversation, the agents and the files, as its opener read them.
 */
export function RestoreDialog({
  open,
  onOpenChange,
  message,
  harness,
  check,
  onRestore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The text of the message restored to before. */
  message: string;
  /** The lead's harness, as the user knows it: "Claude", "Codex". */
  harness: string;
  check: RestoreCheck;
  /** Restores; resolves whether it did, having reported why not. */
  onRestore: () => Promise<boolean>;
}) {
  const [restoring, setRestoring] = useState(false);

  const restore = () => {
    setRestoring(true);
    void onRestore().then((done) => {
      setRestoring(false);
      if (done) onOpenChange(false);
    });
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 bg-scrim transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 flex w-[26rem] max-w-[calc(100vw-2rem)] -translate-1/2 flex-col gap-4 rounded-2xl border border-line-subtle bg-surface-overlay p-5 text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
          <div className="flex flex-col gap-2">
            <AlertDialog.Title className="text-[14px] font-semibold tracking-tight max-md:text-[16px]">
              Restore to before this message?
            </AlertDialog.Title>
            <AlertDialog.Description className="line-clamp-2 border-l-2 border-line-strong pl-2.5 text-[13px] leading-relaxed text-fg-secondary">
              {message.trim() === "" ? "(attachments only)" : message}
            </AlertDialog.Description>
          </div>
          {check.status === "loading" ? (
            <p className="animate-pulse text-[13px] text-fg-tertiary">Checking what changed since…</p>
          ) : check.status === "failed" ? (
            <p className="text-[13px] text-error">{check.message}</p>
          ) : (
            <Consequences preview={check.preview} harness={harness} />
          )}
          <p className="text-[12px] text-fg-tertiary">What's undone stays in the thread to look back on.</p>
          <div className="flex justify-end gap-2">
            <AlertDialog.Close className="h-8 rounded-lg border border-line-strong px-3 text-[13px] font-medium text-fg-primary transition-colors hover:bg-surface-hover max-md:h-10 max-md:px-4 max-md:text-[15px]">
              Cancel
            </AlertDialog.Close>
            <Button
              disabled={check.status !== "ready" || restoring}
              onClick={restore}
              className="h-8 rounded-lg border border-error/35 bg-error/15 px-3 text-[13px] font-medium text-error transition-colors hover:bg-error/25 disabled:opacity-50 disabled:hover:bg-error/15 max-md:h-10 max-md:px-4 max-md:text-[15px]"
            >
              {restoring ? "Restoring…" : "Restore"}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
