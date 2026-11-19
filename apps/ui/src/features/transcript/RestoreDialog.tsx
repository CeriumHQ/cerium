import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { RestorePreview } from "@cerium/protocol";
import { Bot, FileClock, History, MessageSquareX, TriangleAlert, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button, buttonClass } from "../../components/ui/Button.tsx";
import { Disclosure } from "../../components/ui/Disclosure.tsx";
import { dialogBackdropClass, dialogPopupClass, dialogTitleClass } from "../../components/ui/FormDialog.tsx";
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
        className={`mt-[3px] shrink-0 ${tone === "warning" ? "text-attention-text" : "text-fg-tertiary"}`}
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
          <li key={file.path} className="flex items-baseline gap-2 text-meta">
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
    <ul className="flex flex-col gap-2.5 text-body leading-snug text-fg-primary">
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
        <AlertDialog.Backdrop className={dialogBackdropClass} />
        <AlertDialog.Popup className={`${dialogPopupClass("md")} flex flex-col gap-4`}>
          <div className="flex flex-col gap-2">
            <AlertDialog.Title className={dialogTitleClass}>
              Restore to before this message?
            </AlertDialog.Title>
            <AlertDialog.Description className="line-clamp-2 border-l-2 border-line-strong pl-2.5 text-body leading-relaxed text-fg-secondary">
              {message.trim() === "" ? "(attachments only)" : message}
            </AlertDialog.Description>
          </div>
          {check.status === "loading" ? (
            <p className="animate-pulse text-body text-fg-tertiary">Checking what changed since…</p>
          ) : check.status === "failed" ? (
            <p className="text-body text-error-text">{check.message}</p>
          ) : (
            <Consequences preview={check.preview} harness={harness} />
          )}
          <p className="text-meta text-fg-tertiary">What's undone stays in the thread to look back on.</p>
          <div className="flex justify-end gap-2">
            <AlertDialog.Close className={buttonClass()}>Cancel</AlertDialog.Close>
            <Button tone="danger" disabled={check.status !== "ready" || restoring} onClick={restore}>
              {restoring ? "Restoring…" : "Restore"}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
