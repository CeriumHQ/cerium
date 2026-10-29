import { Button } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import { ArrowUp, MessageCircleQuestionMark, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { Markdown } from "../transcript/Markdown.tsx";

// A side question: a pop-over over the message box that answers a quick question with the thread's
// conversation in view, and forgets it. Nothing is added to the thread; closing the pop-over drops
// every question and answer in it.

/** Answers a question given the side questions already answered in the pop-over. */
export type AskSide = (
  question: string,
  earlier: ReadonlyArray<{ readonly question: string; readonly answer: string }>,
) => Promise<string>;

interface Entry {
  readonly id: number;
  readonly question: string;
  readonly answer?: string;
  readonly failure?: string;
}

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Couldn't answer.";

export function SideQuestion({
  open,
  anchor,
  initial,
  ask,
  onClose,
  finalFocus,
}: {
  open: boolean;
  /** The message box, which the pop-over sits above. */
  anchor: RefObject<HTMLElement | null>;
  /** A question to ask as soon as it opens. */
  initial: string;
  ask: AskSide;
  onClose: () => void;
  /** Where the cursor goes back to when it closes. */
  finalFocus: RefObject<HTMLElement | null>;
}) {
  const [entries, setEntries] = useState<ReadonlyArray<Entry>>([]);
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const count = useRef(0);
  const started = useRef(false);
  const pending = entries.some((entry) => entry.answer === undefined && entry.failure === undefined);

  const put = (raw: string) => {
    const question = raw.trim();
    if (question === "" || pending) return;
    const id = count.current++;
    const earlier = entries.flatMap((entry) =>
      entry.answer === undefined ? [] : [{ question: entry.question, answer: entry.answer }],
    );
    const settle = (change: Partial<Entry>) =>
      setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)));
    setEntries((current) => [...current, { id, question }]);
    setText("");
    ask(question, earlier).then(
      (answer) => settle({ answer }),
      (error: unknown) => settle({ failure: messageOf(error) }),
    );
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    put(initial);
    // Once, when it opens; `put` reads state that is empty then.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The newest answer comes into view as it arrives.
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight });
  }, [entries]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      put(text);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          side="top"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 outline-none"
        >
          <Popover.Popup
            initialFocus={field}
            finalFocus={finalFocus}
            // Keys here are the pop-over's own: Esc closes it, and must not reach the box and stop the turn.
            onKeyDown={(event) => event.stopPropagation()}
            className="flex w-[min(46.2rem,calc(100vw-1.5rem))] origin-(--transform-origin) flex-col rounded-xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0"
          >
            <div className="flex h-9 items-center gap-2 pr-1.5 pl-3 text-meta text-fg-tertiary">
              <MessageCircleQuestionMark size={13} strokeWidth={1.75} className="shrink-0" />
              <Popover.Title className="font-medium text-fg-secondary">Side question</Popover.Title>
              <span className="min-w-0 flex-1 truncate">Not added to the thread</span>
              <Popover.Close
                aria-label="Close"
                className="grid size-6 place-items-center rounded-md transition-colors hover:bg-surface-hover hover:text-fg-primary"
              >
                <X size={13} strokeWidth={1.75} />
              </Popover.Close>
            </div>
            {entries.length > 0 ? (
              <ScrollArea viewportRef={viewport} viewportClassName="max-h-[min(22rem,45vh)]">
                <div className="flex flex-col gap-3 px-3 pb-2">
                  {entries.map((entry) => (
                    <div key={entry.id} className="flex flex-col gap-1.5">
                      <p className="text-body font-medium text-fg-primary">{entry.question}</p>
                      {entry.answer !== undefined ? (
                        <Markdown text={entry.answer} streaming={false} compact />
                      ) : entry.failure !== undefined ? (
                        <p className="text-body text-error-text">{entry.failure}</p>
                      ) : (
                        <p className="flex items-center gap-2 text-body text-fg-tertiary">
                          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-running" />
                          Thinking
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            ) : null}
            <div className="flex items-end gap-1.5 border-t border-line-subtle p-2">
              <textarea
                ref={field}
                aria-label={entries.length === 0 ? "Question" : "Follow-up"}
                value={text}
                rows={1}
                placeholder={entries.length === 0 ? "Ask about this thread" : "Ask a follow-up"}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKeyDown}
                className="block max-h-32 min-h-8 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-body outline-none [field-sizing:content] placeholder:text-fg-disabled"
              />
              <Button
                aria-label="Ask"
                disabled={text.trim() === "" || pending}
                onClick={() => put(text)}
                className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition-[opacity,background-color] hover:opacity-90 disabled:bg-transparent disabled:text-fg-tertiary disabled:opacity-100 disabled:ring-1 disabled:ring-line-strong disabled:ring-inset"
              >
                <ArrowUp size={15} strokeWidth={2} />
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
