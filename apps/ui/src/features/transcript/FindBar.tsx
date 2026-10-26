import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { useKeptHidden } from "../../components/KeptViews.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import {
  findJumpAtom,
  findRanges,
  FIND_EVENT,
  jumpCandidates,
  JUMP_WAIT_MS,
  markFor,
  matchedWords,
  rangeOf,
  ringMessage,
  showRange,
  wordRanges,
  type FindJump,
} from "./find.ts";
import type { TranscriptBlock } from "./model.ts";

/** How long the conversation has to settle before a streaming reply is searched again while the bar is open. */
const RESCAN_MS = 200;

const iconButton =
  "grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:pointer-events-none disabled:opacity-40";

/**
 * The find bar over a thread's conversation, Ctrl F: matches highlight as the user types, a count shows
 * which one is current, and Enter, Shift Enter or the arrows step through them. It searches the messages
 * and replies the conversation shows, folded ones included; tool runs and reasoning are left out. Also
 * brings in the message a palette search picked, and marks the words it matched.
 */
export function TranscriptFind({
  scope,
  threadId,
  focused,
  blocks,
}: {
  /** The column that holds the conversation's messages. */
  readonly scope: RefObject<HTMLDivElement | null>;
  readonly threadId: string | undefined;
  /** The pane has focus: Ctrl F opens the bar here and in no other pane. */
  readonly focused: boolean;
  readonly blocks: ReadonlyArray<TranscriptBlock>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ReadonlyArray<Range>>([]);
  const [current, setCurrent] = useState(0);
  /** Bumped each time Ctrl F asks for the bar, so an open bar takes the cursor again. */
  const [asked, setAsked] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  /** Where the cursor was before the bar took it, which it goes back to. */
  const returnTo = useRef<HTMLElement | null>(null);
  const jump = useAtomValue(findJumpAtom);
  const takeJump = useAtomSet(findJumpAtom);
  const hidden = useKeptHidden();

  /** Finds `typed` in the conversation again; `reveal` brings the first match into view. */
  const search = (typed: string, reveal: boolean) => {
    const column = scope.current;
    const found = column && typed !== "" ? findRanges(column, typed) : [];
    setMatches(found);
    setCurrent((index) => (reveal ? 0 : Math.max(0, Math.min(index, found.length - 1))));
    const first = found[0];
    if (reveal && first) requestAnimationFrame(() => showRange(first, false));
  };

  const askFind = useEffectEvent(() => {
    if (!open) {
      const active = document.activeElement;
      returnTo.current = active instanceof HTMLElement ? active : null;
      setOpen(true);
      search(query, true);
    }
    setAsked((count) => count + 1);
  });
  useEffect(() => {
    if (!focused) return;
    const listener = () => askFind();
    window.addEventListener(FIND_EVENT, listener);
    return () => window.removeEventListener(FIND_EVENT, listener);
  }, [focused]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    input.current?.select();
  }, [open, asked]);

  /** Searches again as the conversation changes, which a reply still streaming in does until it pauses. */
  const rescan = useEffectEvent(() => search(query, false));
  useEffect(() => {
    const column = scope.current;
    if (!open || !column) return;
    let timer = 0;
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => rescan(), RESCAN_MS);
    });
    observer.observe(column, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [open, scope]);

  // The matches light up while the bar is open, the current one stronger; the names are the ones the stylesheet gives.
  useEffect(() => {
    if (!open) return;
    CSS.highlights.set("find", new Highlight(...matches));
    const active = matches[current];
    if (active) CSS.highlights.set("find-current", new Highlight(active));
    else CSS.highlights.delete("find-current");
    return () => {
      CSS.highlights.delete("find");
      CSS.highlights.delete("find-current");
    };
  }, [open, matches, current]);

  const close = () => {
    setOpen(false);
    const back = returnTo.current;
    returnTo.current = null;
    if (back?.isConnected) back.focus();
  };

  const step = (by: number) => {
    if (matches.length === 0) return;
    const next = (current + by + matches.length) % matches.length;
    const target = matches[next];
    setCurrent(next);
    if (target) showRange(target, true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    // Escape closes the bar alone: a running turn's Escape stops it only when the bar is shut.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      step(event.key === "ArrowDown" ? 1 : -1);
    }
  };

  // A message a palette search picked is brought in once its thread has drawn it, which can take a moment.
  const dropJump = useEffectEvent(() => takeJump(undefined));
  const locate = useEffectEvent((request: FindJump): boolean => {
    const column = scope.current;
    if (!column) return false;
    const messages = blocks.flatMap((block) =>
      block.kind === "user" || block.kind === "message" ? [{ id: block.id, text: block.text }] : [],
    );
    for (const id of jumpCandidates(messages, request.passage)) {
      const message = column.querySelector<HTMLElement>(`[data-find="${CSS.escape(id)}"]`);
      if (message === null) continue;
      const words = wordRanges(message, matchedWords(request.passage));
      showRange(words[0] ?? rangeOf(message), true);
      ringMessage(message);
      if (words.length > 0) markFor("find-jump", words);
      return true;
    }
    return false;
  });
  useEffect(() => {
    // A conversation kept out of sight leaves it to the one showing the thread, or takes it once it shows.
    if (hidden || jump === undefined || jump.threadId !== threadId) return;
    if (Date.now() - jump.at > JUMP_WAIT_MS) {
      dropJump();
      return;
    }
    const deadline = performance.now() + JUMP_WAIT_MS;
    let frame = 0;
    const look = () => {
      if (locate(jump)) dropJump();
      else if (performance.now() < deadline) frame = requestAnimationFrame(look);
      else dropJump();
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [jump, threadId, hidden]);

  if (!open) return null;
  const count =
    query === "" ? "" : matches.length === 0 ? "No matches" : `${current + 1} / ${matches.length}`;
  return (
    // The keys the bar takes are read wherever focus is inside it, the input or a button.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <search
      aria-label="Find in thread"
      onKeyDown={onKeyDown}
      className="absolute top-3 right-3 z-20 flex h-9 items-center gap-0.5 rounded-xl border border-line-subtle bg-surface-overlay pr-1 pl-2.5 text-body text-fg-primary shadow-overlay backdrop-blur-2xl"
    >
      <Input
        ref={input}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          search(event.target.value, true);
        }}
        placeholder="Find in thread"
        aria-label="Find in thread"
        className="w-40 min-w-0 bg-transparent outline-none placeholder:text-fg-tertiary max-md:text-base"
      />
      <output aria-live="polite" className="shrink-0 px-1.5 text-meta text-fg-tertiary tabular-nums">
        {count}
      </output>
      <Tooltip label="Previous match" shortcut="Shift Enter">
        <Button
          aria-label="Previous match"
          disabled={matches.length === 0}
          onClick={() => step(-1)}
          className={iconButton}
        >
          <ChevronUp size={15} strokeWidth={1.75} />
        </Button>
      </Tooltip>
      <Tooltip label="Next match" shortcut="Enter">
        <Button
          aria-label="Next match"
          disabled={matches.length === 0}
          onClick={() => step(1)}
          className={iconButton}
        >
          <ChevronDown size={15} strokeWidth={1.75} />
        </Button>
      </Tooltip>
      <Tooltip label="Close" shortcut="Esc">
        <Button aria-label="Close find" onClick={close} className={iconButton}>
          <X size={14} strokeWidth={1.75} />
        </Button>
      </Tooltip>
    </search>
  );
}
