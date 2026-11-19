import type { CloneEvent } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";

import { pickFolder } from "../../../backend/shell.ts";
import { cloneAtom } from "../../../backend/repositories.ts";
import { DialogButton, DialogField, DialogInput, FormDialog } from "../../../components/ui/FormDialog.tsx";
import { messageOf } from "../../viewer/previews.tsx";

// Cloning a repository into a folder the user picks, and opening the clone as a project. Git's progress
// shows while it runs; a clone that fails says why in plain words, and the dialog stays for another try.

interface CloneDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The clone finished: the folder it made, to open as a project. */
  readonly onCloned: (path: string) => void;
}

/** One clone, mounted while it runs: its progress, its failure, and the folder it makes when done. */
function CloneRun({
  attempt,
  onCloned,
}: {
  readonly attempt: string;
  readonly onCloned: (path: string) => void;
}) {
  const result = useAtomValue(cloneAtom(attempt));
  const latest = AsyncResult.getOrElse(result, (): CloneEvent | undefined => undefined);
  const cloned = latest?._tag === "Cloned" ? latest.path : undefined;

  useEffect(() => {
    if (cloned !== undefined) onCloned(cloned);
  }, [cloned, onCloned]);

  if (AsyncResult.isFailure(result)) {
    return (
      <p role="alert" className="text-meta leading-relaxed text-error-text">
        {messageOf(result.cause, "The clone didn't finish.")}
      </p>
    );
  }
  return (
    <p className="truncate font-mono text-meta text-fg-tertiary" aria-live="polite">
      {latest?._tag === "Progress" ? latest.text : "Starting git…"}
    </p>
  );
}

/** Asks for an address and a folder, then clones the repository into a folder of its own inside it. */
export function CloneDialog({ open, onOpenChange, onCloned }: CloneDialogProps) {
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState<string>();
  /** The clone running or last run: its address, folder and when it started, which keys it. */
  const [attempt, setAttempt] = useState<string>();

  const start = () => {
    const address = url.trim();
    if (address === "" || folder === undefined) return;
    setAttempt(`${address}\n${folder}\n${Date.now()}`);
  };

  const browse = () => {
    void pickFolder().then((picked) => {
      if (picked !== undefined) setFolder(picked);
    });
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        // Closing stops a clone that's still running.
        if (!next) setAttempt(undefined);
        onOpenChange(next);
      }}
      title="Clone a repository"
      description="It's cloned into a folder of its own, named after the repository, and opened as a project."
      onSubmit={start}
      actions={
        <DialogButton type="submit" tone="primary" disabled={url.trim() === "" || folder === undefined}>
          Clone
        </DialogButton>
      }
    >
      <DialogField label="Address">
        <DialogInput
          value={url}
          onChange={(event) => setUrl(event.currentTarget.value)}
          placeholder="https://github.com/owner/repository.git"
        />
      </DialogField>
      <div className="flex flex-col gap-1.5">
        <span className="text-meta text-fg-secondary max-md:text-[13px]">Into</span>
        <button
          type="button"
          onClick={browse}
          className="flex h-8 min-w-0 items-center gap-2 rounded-lg border border-line-strong px-2.5 text-left text-body transition-colors hover:bg-surface-hover max-md:h-10 max-md:text-[15px]"
        >
          <FolderOpen size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
          <span className={`truncate ${folder === undefined ? "text-fg-tertiary" : "text-fg-primary"}`}>
            {folder ?? "Choose a folder"}
          </span>
        </button>
      </div>
      {attempt !== undefined ? <CloneRun key={attempt} attempt={attempt} onCloned={onCloned} /> : null}
    </FormDialog>
  );
}
