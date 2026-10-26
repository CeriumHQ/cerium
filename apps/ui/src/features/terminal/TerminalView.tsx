import { Button } from "@base-ui/react/button";
import type { TerminalInfo } from "@cerium/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ClipboardPaste, Copy, Eraser, Globe, RotateCcw, TextSelect } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { restartTerminal, terminalSessionAtom } from "../../backend/terminals.ts";
import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { usesCommandKey } from "../../lib/keys.ts";
import { canOpenLocally, openLocally, shortUrl } from "../preview/model.ts";
import { exitNote, messageOf } from "./model.ts";
import type { TerminalSession } from "./session.ts";

/**
 * One terminal: the emulator filling its space, and once the shell has ended, a quiet line saying so
 * with the way to start another. `focus` counts requests to put the cursor in it.
 */
export function TerminalView({
  terminal,
  focus,
  onError,
}: {
  terminal: TerminalInfo;
  focus: number;
  onError: (message: string) => void;
}) {
  const result = useAtomValue(terminalSessionAtom(`${terminal.id}:${terminal.run}`));
  const session = AsyncResult.isSuccess(result) ? result.value : undefined;
  const container = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(false);
  const restart = useAtomSet(restartTerminal, { mode: "promise" });
  const ended = terminal.exitCode !== undefined;

  useLayoutEffect(() => {
    const element = container.current;
    if (session === undefined || element === null) return;
    return session.mount(element);
  }, [session]);

  // The emulator follows the theme as it changes, and takes it as it is when shown again.
  useEffect(() => {
    if (session === undefined) return;
    session.setTheme();
    const observer = new MutationObserver(() => session.setTheme());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-palette"],
    });
    return () => observer.disconnect();
  }, [session]);

  useEffect(() => {
    if (session !== undefined && ended) session.end();
  }, [session, ended]);

  // A dev server's local address, once the terminal prints one, is offered to the thread's preview.
  const localUrl = useSyncExternalStore(
    (listener) => session?.onLocalUrl(listener) ?? (() => undefined),
    () => session?.localUrl,
  );

  useEffect(() => {
    if (session === undefined || focus === 0) return;
    let current = true;
    void session.sized.then(() => {
      if (current) session.focus();
    });
    return () => {
      current = false;
    };
  }, [session, focus]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {localUrl !== undefined && !ended && canOpenLocally() ? (
        <Button
          onClick={() => openLocally(localUrl)}
          className="absolute top-1.5 right-3 z-10 flex h-6 items-center gap-1.5 rounded-md bg-surface-raised px-2 text-meta text-fg-secondary shadow-raised ring-1 ring-line-subtle transition-colors hover:bg-surface-hover hover:text-fg-primary starting:opacity-0"
        >
          <Globe size={12} strokeWidth={1.75} aria-hidden />
          <span>Preview {shortUrl(localUrl)}</span>
        </Button>
      ) : null}
      <ContextMenuArea menu={<TerminalMenu session={session} selected={selected} />}>
        <div
          ref={container}
          onContextMenu={() => setSelected(session?.hasSelection() ?? false)}
          className="min-h-0 flex-1 px-3 pt-1 pb-2"
        />
      </ContextMenuArea>
      {ended ? (
        <div className="flex h-8 shrink-0 items-center gap-1.5 px-3 text-meta text-fg-tertiary">
          <span>{exitNote(terminal.exitCode)}</span>
          <Button
            onClick={() => {
              restart({
                payload: { id: terminal.id, size: session?.size() ?? { cols: 100, rows: 24 } },
              }).catch((error: unknown) => onError(messageOf(error)));
            }}
            className="flex h-6 items-center gap-1 rounded-md px-1.5 text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
          >
            <RotateCcw size={12} strokeWidth={1.75} />
            Restart
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Right-clicking the terminal: what a text field's menu offers, over the emulator's selection. */
function TerminalMenu({ session, selected }: { session: TerminalSession | undefined; selected: boolean }) {
  const act = (run: (session: TerminalSession) => void) => () => {
    if (session === undefined) return;
    run(session);
    session.focus();
  };
  return (
    <>
      <MenuItem
        icon={Copy}
        shortcut={usesCommandKey() ? "Ctrl C" : "Ctrl Shift C"}
        disabled={!selected}
        onClick={act((each) => each.copySelection())}
      >
        Copy
      </MenuItem>
      <MenuItem
        icon={ClipboardPaste}
        shortcut={usesCommandKey() ? "Ctrl V" : "Ctrl Shift V"}
        onClick={act(
          (each) =>
            void navigator.clipboard
              ?.readText()
              .then((text) => each.paste(text))
              .catch(() => undefined),
        )}
      >
        Paste
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={TextSelect} onClick={act((each) => each.selectAll())}>
        Select all
      </MenuItem>
      <MenuItem icon={Eraser} onClick={act((each) => each.clear())}>
        Clear
      </MenuItem>
    </>
  );
}
