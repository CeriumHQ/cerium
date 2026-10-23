import { Button } from "@base-ui/react/button";
import { Tabs } from "@base-ui/react/tabs";
import type { ThreadId } from "@cerium/protocol";
import type { TerminalId, TerminalInfo } from "@cerium/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ChevronDown, Plus, X } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { Notice } from "../../app/Notice.tsx";
import { usePanelWidth } from "../../app/ResizeHandle.tsx";
import { closeTerminal, openTerminal, terminalsAtom } from "../../backend/terminals.ts";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { HeightHandle } from "./HeightHandle.tsx";
import { DRAWER, drawerLayout, messageOf, shownTerminal, tabLabels, terminalsOf } from "./model.ts";
import { fittedSize } from "./session.ts";
import { TerminalView } from "./TerminalView.tsx";

/**
 * A work thread's terminals, docked under its conversation: tabs along the top, the open terminal
 * below, and its top edge to drag to the height it should be. In the phone-narrow window it is a pane
 * over the thread instead. Opened with no terminal in the thread, it starts one.
 */
export function TerminalDrawer({
  threadId,
  chosen,
  onChoose,
  focus,
  compact,
  onHide,
  onNewFocus,
}: {
  threadId: string;
  /** The terminal this thread last showed. */
  chosen: string | undefined;
  onChoose: (id: TerminalId) => void;
  /** Counts the times the cursor should go to the terminal. */
  focus: number;
  compact: boolean;
  onHide: () => void;
  /** A terminal was started or picked: the cursor goes to it. */
  onNewFocus: () => void;
}) {
  const listed = useAtomValue(terminalsAtom);
  const loaded = AsyncResult.isSuccess(listed);
  const all = AsyncResult.getOrElse(listed, () => []);
  const terminals = terminalsOf(all, threadId);
  const labels = tabLabels(terminals);
  const shown = shownTerminal(terminals, chosen);
  const open = useAtomSet(openTerminal, { mode: "promise" });
  const close = useAtomSet(closeTerminal, { mode: "promise" });
  const [error, setError] = useState<string>();
  const starting = useRef(false);

  const [saved, setSaved, rememberHeight] = usePanelWidth(DRAWER.key, DRAWER.fallback);
  const section = useRef<HTMLElement>(null);
  const [columnHeight, setColumnHeight] = useState(0);
  useLayoutEffect(() => {
    const column = section.current?.parentElement;
    if (column == null) return;
    const measure = () => setColumnHeight(column.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, []);
  const layout = drawerLayout(columnHeight || window.innerHeight, saved);

  /** Starts a shell in the thread's folder, and shows it. */
  const start = () => {
    if (starting.current) return;
    starting.current = true;
    setError(undefined);
    open({ payload: { threadId: threadId as ThreadId, size: fittedSize() } }).then(
      (info) => {
        starting.current = false;
        onChoose(info.id);
        onNewFocus();
      },
      (failure: unknown) => {
        starting.current = false;
        setError(messageOf(failure));
      },
    );
  };

  // Opened with nothing to show, the drawer starts the thread's first terminal. Once it has shown
  // one, its last closing (here, or from another device) takes the drawer with it instead.
  const shownAny = useRef(false);
  const onCount = useEffectEvent((count: number) => {
    if (count > 0) shownAny.current = true;
    else if (shownAny.current) onHide();
    else start();
  });
  useEffect(() => {
    if (loaded) onCount(terminals.length);
  }, [loaded, terminals.length]);

  // Closing the last one takes the drawer with it, once the list says it's gone.
  const closeTab = (terminal: TerminalInfo) => {
    close({ payload: { id: terminal.id } }).catch((failure: unknown) => setError(messageOf(failure)));
  };

  return (
    <section
      ref={section}
      data-terminal-drawer=""
      aria-label="Terminal"
      style={compact ? undefined : { height: layout.height }}
      className={
        compact
          ? "absolute inset-0 z-20 flex flex-col bg-surface-panel backdrop-blur-2xl"
          : "relative z-10 flex shrink-0 flex-col border-t border-line-subtle bg-surface-window"
      }
    >
      {compact ? null : (
        <HeightHandle
          height={layout.height}
          min={DRAWER.min}
          max={layout.max}
          fallback={DRAWER.fallback}
          onResize={setSaved}
          onCommit={rememberHeight}
        />
      )}
      <Tabs.Root
        value={shown?.id ?? null}
        onValueChange={(id) => {
          onChoose(id as TerminalId);
          onNewFocus();
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex h-9 shrink-0 items-center gap-1 pr-1.5 pl-2">
          <Tabs.List className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
            {terminals.map((terminal, index) => (
              <div
                key={terminal.id}
                className="group/tab flex shrink-0 items-center rounded-md transition-colors has-[[data-active]]:bg-surface-selected hover:bg-surface-hover"
              >
                <Tabs.Tab
                  value={terminal.id}
                  className={`h-7 rounded-md pr-1 pl-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-focus-ring data-active:text-fg-primary ${
                    terminal.exitCode === undefined ? "text-fg-tertiary" : "text-fg-disabled"
                  }`}
                >
                  {labels[index]}
                </Tabs.Tab>
                <Button
                  aria-label={`Close ${labels[index] ?? "terminal"}`}
                  onClick={() => closeTab(terminal)}
                  className={`mr-1 grid size-5 place-items-center rounded text-fg-tertiary transition-[opacity,color,background-color] hover:bg-surface-active hover:text-fg-primary focus-visible:opacity-100 pointer-coarse:size-7 ${
                    terminal.id === shown?.id
                      ? ""
                      : "opacity-0 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100 pointer-coarse:opacity-100"
                  }`}
                >
                  <X size={12} strokeWidth={1.75} />
                </Button>
              </div>
            ))}
          </Tabs.List>
          <IconButton icon={Plus} label="New terminal" onClick={start} />
          <div className="ml-auto" />
          <IconButton icon={ChevronDown} label="Hide terminal" shortcut="Control `" onClick={onHide} />
        </div>
        {error ? (
          <Notice tone="error" clamp onDismiss={() => setError(undefined)}>
            {error}
          </Notice>
        ) : null}
        <div className="min-h-0 flex-1">
          {shown ? (
            <Tabs.Panel value={shown.id} keepMounted className="h-full outline-none">
              <TerminalView key={shown.id} terminal={shown} focus={focus} onError={setError} />
            </Tabs.Panel>
          ) : null}
        </div>
      </Tabs.Root>
    </section>
  );
}
