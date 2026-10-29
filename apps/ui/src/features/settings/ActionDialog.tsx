import { Dialog } from "@base-ui/react/dialog";
import type { CommandTerminal, HarnessCommand } from "@cerium/rpc";
import type { ProviderId } from "@cerium/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Check, Copy, RefreshCw } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { closeTerminal, commandSessionAtom, runHarnessCommand } from "../../backend/terminals.ts";
import { Swap } from "../../components/Swap.tsx";
import { DialogButton } from "../../components/ui/FormDialog.tsx";
import { messageOf } from "../terminal/model.ts";
import { fittedSize } from "../terminal/session.ts";

// The one place a harness, or `gh`, signs in or updates from Settings: a dialog over the harness's own
// flow. A CLI's command runs in a terminal inside it; an SDK's browser sign-in shows its progress.
// Whatever the flow creates stays with the harness.

/** The dialog's frame. `finished` turns Cancel into Done; closing it lets go of the flow inside. */
export function ActionDialog({
  open,
  onOpenChange,
  title,
  description,
  finished = false,
  wide = false,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: ReactNode;
  readonly finished?: boolean;
  /** Room for a terminal. */
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-scrim transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          className={`fixed top-[calc(var(--app-top,0px)+var(--app-height,100dvh)/2)] left-1/2 flex ${wide ? "w-[40rem]" : "w-[26rem]"} max-h-[calc(var(--app-height,100dvh)-2rem)] max-w-[calc(100vw-2rem)] -translate-1/2 flex-col gap-4 overflow-y-auto overscroll-contain rounded-2xl border border-line-subtle bg-surface-overlay p-5 text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0`}
        >
          <div className="flex flex-col gap-1.5">
            <Dialog.Title className="text-reading font-semibold tracking-tight max-md:text-[16px]">
              {title}
            </Dialog.Title>
            <Dialog.Description className="text-body leading-relaxed text-fg-secondary max-md:text-[14px]">
              {description}
            </Dialog.Description>
          </div>
          {children}
          <div className="flex justify-end">
            <Dialog.Close render={<DialogButton tone={finished ? "primary" : "neutral"} />}>
              {finished ? "Done" : "Cancel"}
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * A harness's own command, `login` or `update`, running in a terminal in the dialog. It's started by
 * the click that opens the dialog (`startCommand`), so it runs once; closing the dialog ends it.
 * `command` is what it runs, offered to copy when this machine can't run it here.
 */
export function CommandDialog({
  started,
  onClose,
  title,
  description,
  command,
  onFinished,
}: {
  /** The command's terminal, once it has one; the dialog is open while there's one. */
  readonly started: Promise<CommandTerminal> | undefined;
  readonly onClose: () => void;
  readonly title: string;
  readonly description: ReactNode;
  readonly command: string | undefined;
  /** The command ended: the harnesses are checked again. */
  readonly onFinished: () => void;
}) {
  const close = useAtomSet(closeTerminal, { mode: "promise" });
  // Which run ended, so a dialog that moves on to another command starts unfinished.
  const [finishedRun, setFinishedRun] = useState<Promise<CommandTerminal>>();
  const finished = started !== undefined && finishedRun === started;
  return (
    <ActionDialog
      open={started !== undefined}
      onOpenChange={(open) => {
        if (open) return;
        void started?.then((terminal) => close({ payload: { id: terminal.id } })).catch(() => undefined);
        setFinishedRun(undefined);
        onClose();
      }}
      title={title}
      description={description}
      finished={finished}
      wide
    >
      {started === undefined ? null : (
        <CommandRun
          started={started}
          command={command}
          onEnded={() => {
            setFinishedRun(started);
            onFinished();
          }}
        />
      )}
    </ActionDialog>
  );
}

/** Starts a harness's own command for `CommandDialog`, from the click that opens it. */
export function useStartCommand(provider: ProviderId) {
  const run = useAtomSet(runHarnessCommand, { mode: "promise" });
  return (action: HarnessCommand) => run({ payload: { provider, action, size: fittedSize() } });
}

/** The command's terminal once it has started, or why it didn't. */
function CommandRun({
  started,
  command,
  onEnded,
}: {
  readonly started: Promise<CommandTerminal>;
  readonly command: string | undefined;
  readonly onEnded: () => void;
}) {
  const [terminal, setTerminal] = useState<CommandTerminal>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    let current = true;
    started.then(
      (each) => {
        if (current) setTerminal(each);
      },
      (error: unknown) => {
        if (current) setFailure(messageOf(error));
      },
    );
    return () => {
      current = false;
    };
  }, [started]);

  if (failure !== undefined) {
    return (
      <div className="flex flex-col gap-2 text-meta">
        <p className="text-error-text">{failure}</p>
        {command === undefined ? null : (
          <>
            <p className="text-fg-secondary">Run this in a terminal instead, then check again:</p>
            <CopyableCommand text={command} />
          </>
        )}
      </div>
    );
  }
  return (
    <div className="h-72 overflow-hidden rounded-xl border border-line-subtle bg-surface-window max-md:h-[50dvh]">
      {terminal === undefined ? (
        <p className="flex items-center gap-2 p-3 text-meta text-fg-tertiary">
          <RefreshCw size={12} strokeWidth={1.75} className="animate-spin" />
          Starting…
        </p>
      ) : (
        <CommandTerminalView sessionKey={`${terminal.id}:${terminal.windowsBuild ?? ""}`} onEnded={onEnded} />
      )}
    </div>
  );
}

/**
 * A command terminal's emulator, following the command while it's mounted. `shown` false keeps
 * following it, to hear when it ends, without drawing it.
 */
export function CommandTerminalView({
  sessionKey,
  onEnded,
  shown = true,
}: {
  readonly sessionKey: string;
  /** With the command's exit code; none when the terminal was closed. */
  readonly onEnded: (code: number | undefined) => void;
  readonly shown?: boolean;
}) {
  const result = useAtomValue(commandSessionAtom(sessionKey));
  const session = AsyncResult.isSuccess(result) ? result.value : undefined;
  const container = useRef<HTMLDivElement>(null);
  const ended = useEffectEvent(onEnded);

  useLayoutEffect(() => {
    const element = container.current;
    if (session === undefined || element === null || !shown) return;
    return session.mount(element);
  }, [session, shown]);

  useEffect(() => {
    if (session === undefined || !shown) return;
    let current = true;
    void session.sized.then(() => {
      if (current) session.focus();
    });
    return () => {
      current = false;
    };
  }, [session, shown]);

  useEffect(() => {
    if (session === undefined) return;
    let current = true;
    void session.ended.then((code) => {
      if (current) ended(code);
    });
    session.setTheme();
    const observer = new MutationObserver(() => session.setTheme());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-palette", "data-desktop"],
    });
    return () => {
      current = false;
      observer.disconnect();
    };
  }, [session]);

  // xterm draws its own thin scrollbar over the viewport, whose native one only adds a slab.
  return <div ref={container} className="h-full px-3 pt-2 pb-2 [&_.xterm-viewport]:[scrollbar-width:none]" />;
}

/** A command to run in a terminal, with a button that copies it. */
export function CopyableCommand({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line-subtle bg-surface-window py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-meta text-fg-primary select-text">{text}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy command"}
        className="grid size-6 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary"
      >
        <Swap which={copied ? "copied" : "copy"}>
          {copied ? <Check size={13} strokeWidth={2.25} /> : <Copy size={13} strokeWidth={1.75} />}
        </Swap>
      </button>
    </div>
  );
}
