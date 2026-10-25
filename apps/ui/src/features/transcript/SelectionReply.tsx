import { Button } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import { MessageSquareReply } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { useCoarsePointer } from "../composer/pointer.ts";
import { useMessageBox } from "../composer/messageBox.ts";

/** Marks a response whose text the user can select and reply to. */
const REPLY_SOURCE = "data-reply-source";

/** Keeps the passage marked while the comment box has focus, which takes the page's selection. */
const HIGHLIGHT = "cerium-reply";

/** A passage selected inside one response. */
interface Passage {
  readonly range: Range;
  readonly quote: string;
  readonly source: Element;
}

const passageOf = (within: Element): Passage | undefined => {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const source = (common instanceof Element ? common : common.parentElement)?.closest(`[${REPLY_SOURCE}]`);
  const quote = range.toString().trim();
  if (!source || !within.contains(source) || quote === "") return undefined;
  return { range: range.cloneRange(), quote, source };
};

/**
 * A Reply button by the text the user selects in one of the agent's responses, which opens a box to
 * comment on that passage. The comment joins the message box's draft, to send with the next message.
 */
export function SelectionReply({ within }: { within: RefObject<HTMLElement | null> }) {
  const messageBox = useMessageBox();
  const [passage, setPassage] = useState<Passage>();
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const touch = useCoarsePointer();

  const close = () => {
    setPassage(undefined);
    setWriting(false);
    setText("");
  };

  // A selection is read once it's made (the pointer or Shift released), not while it's being dragged.
  const readSelection = useEffectEvent(() => {
    if (writing || within.current === null) return;
    setPassage(passageOf(within.current));
  });
  const dropCollapsed = useEffectEvent(() => {
    if (!writing && document.getSelection()?.isCollapsed !== false) setPassage(undefined);
  });
  useEffect(() => {
    if (messageBox === undefined) return;
    // After the browser settles the selection: a click inside one collapses it only after pointerup.
    const read = () => requestAnimationFrame(() => readSelection());
    document.addEventListener("pointerup", read);
    document.addEventListener("keyup", read);
    document.addEventListener("selectionchange", dropCollapsed);
    return () => {
      document.removeEventListener("pointerup", read);
      document.removeEventListener("keyup", read);
      document.removeEventListener("selectionchange", dropCollapsed);
    };
  }, [messageBox]);

  // Asking to comment puts the cursor in the comment box.
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (writing) field.current?.focus();
  }, [writing]);

  useEffect(() => {
    if (!writing || passage === undefined || typeof Highlight === "undefined") return;
    CSS.highlights.set(HIGHLIGHT, new Highlight(passage.range));
    return () => void CSS.highlights.delete(HIGHLIGHT);
  }, [writing, passage]);

  if (messageBox === undefined) return null;

  const add = () => {
    if (passage === undefined || text.trim() === "") return;
    messageBox.comment({ quote: passage.quote, text: text.trim() });
    document.getSelection()?.removeAllRanges();
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      add();
    }
  };

  return (
    <Popover.Root
      open={passage !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={
            passage && {
              // The whole passage, so the button never covers a line of it.
              getBoundingClientRect: () => passage.range.getBoundingClientRect(),
              contextElement: passage.source,
            }
          }
          // A phone's own selection menu sits above the text.
          side={touch ? "bottom" : "top"}
          align={writing ? "center" : "end"}
          sideOffset={6}
          collisionPadding={12}
          className="z-50 outline-none data-anchor-hidden:invisible"
        >
          <Popover.Popup
            // The button leaves the selection alone; the comment box takes the cursor.
            initialFocus={false}
            finalFocus={false}
            className="origin-(--transform-origin) rounded-xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0"
          >
            {writing ? (
              <div className="flex w-80 flex-col gap-2 p-2.5">
                <Popover.Title className="line-clamp-2 border-l-2 border-accent/60 pl-2 text-meta font-normal text-fg-tertiary">
                  {passage?.quote}
                </Popover.Title>
                <textarea
                  ref={field}
                  aria-label="Comment"
                  value={text}
                  rows={2}
                  placeholder="Comment on this"
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={onKeyDown}
                  className="block max-h-40 min-h-12 w-full resize-none rounded-lg border border-line-subtle bg-surface-raised px-2.5 py-2 text-body outline-none [field-sizing:content] placeholder:text-fg-disabled focus:border-line-strong"
                />
                <div className="flex items-center justify-end gap-1">
                  <Popover.Close className="h-7 rounded-md px-2.5 text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary">
                    Cancel
                  </Popover.Close>
                  <Button
                    onClick={add}
                    disabled={text.trim() === ""}
                    className="h-7 rounded-md bg-accent px-2.5 text-meta font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    Add comment
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                onClick={() => setWriting(true)}
                // Pressing it would otherwise clear the selection before the click lands.
                onPointerDown={(event) => event.preventDefault()}
                className="flex h-7 items-center gap-1.5 rounded-xl px-2.5 text-meta font-medium text-fg-secondary transition-colors hover:text-fg-primary"
              >
                <MessageSquareReply size={13} strokeWidth={1.75} />
                Reply
              </Button>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
