import { Dialog } from "@base-ui/react/dialog";
import type { CloneEvent } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { FolderOpen } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { pickFolder } from "../../../backend/shell.ts";
import { cloneAtom } from "../../../backend/repositories.ts";
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
      <p role="alert" className="text-meta leading-relaxed text-error">
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

  const start = (event: FormEvent) => {
    event.preventDefault();
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
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // Closing stops a clone that's still running.
        if (!next) setAttempt(undefined);
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-scrim transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 flex w-[26rem] max-w-[calc(100vw-2rem)] -translate-1/2 flex-col gap-4 rounded-2xl border border-line-subtle bg-surface-overlay p-5 text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
          <div className="flex flex-col gap-1.5">
            <Dialog.Title className="text-reading font-semibold tracking-tight max-md:text-[16px]">
              Clone a repository
            </Dialog.Title>
            <Dialog.Description className="text-body leading-relaxed text-fg-secondary max-md:text-[14px]">
              It's cloned into a folder of its own, named after the repository, and opened as a project.
            </Dialog.Description>
          </div>
          <form className="flex flex-col gap-3" onSubmit={start}>
            <label className="flex flex-col gap-1.5">
              <span className="text-meta text-fg-secondary">Address</span>
              <input
                value={url}
                onChange={(event) => setUrl(event.currentTarget.value)}
                placeholder="https://github.com/owner/repository.git"
                spellCheck={false}
                className="h-8 rounded-lg border border-line-strong bg-transparent px-2.5 text-body text-fg-primary outline-none placeholder:text-fg-tertiary"
              />
            </label>
            <div className="flex flex-col gap-1.5">
              <span className="text-meta text-fg-secondary">Into</span>
              <button
                type="button"
                onClick={browse}
                className="flex h-8 min-w-0 items-center gap-2 rounded-lg border border-line-strong px-2.5 text-left text-body transition-colors hover:bg-surface-hover"
              >
                <FolderOpen size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
                <span className={`truncate ${folder === undefined ? "text-fg-tertiary" : "text-fg-primary"}`}>
                  {folder ?? "Choose a folder"}
                </span>
              </button>
            </div>
            {attempt !== undefined ? <CloneRun key={attempt} attempt={attempt} onCloned={onCloned} /> : null}
            <div className="flex justify-end gap-2">
              <Dialog.Close className="h-8 rounded-lg border border-line-strong px-3 text-body font-medium text-fg-primary transition-colors hover:bg-surface-hover max-md:h-10 max-md:px-4 max-md:text-[15px]">
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={url.trim() === "" || folder === undefined}
                className="h-8 rounded-lg border border-line-strong bg-surface-hover px-3 text-body font-medium text-fg-primary transition-colors hover:bg-surface-active disabled:opacity-45 max-md:h-10 max-md:px-4 max-md:text-[15px]"
              >
                Clone
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
