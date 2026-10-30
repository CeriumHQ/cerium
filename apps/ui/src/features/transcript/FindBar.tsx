import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { artifactBlocks, artifactId } from "@cerium/artifacts";
import type { AgentEvent, AgentId } from "@cerium/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { readCloudSearchHistory, readSearchHistory } from "../../backend/atoms.ts";
import type { ThreadHistory } from "../../backend/threadLog.ts";
import { useKeptHidden } from "../../components/KeptViews.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import {
  findJumpAtom,
  findRanges,
  FIND_EVENT,
  jumpCandidates,
  markFor,
  matchedWords,
  rangeOf,
  ringMessage,
  showRange,
  wordRanges,
} from "./find.ts";
import { HISTORY_EVENT } from "./HistoryWindow.tsx";
import type { TranscriptBlock } from "./model.ts";
import {
  messagesFromHistory,
  modelMatches,
  searchMessages,
  type ModelMatch,
  type SearchMessage,
} from "./searchModel.ts";

const RESCAN_MS = 200;
const iconButton =
  "grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:pointer-events-none disabled:opacity-40";
interface Pending {
  readonly message: SearchMessage;
  readonly ordinal: number;
  readonly query: string;
  readonly words?: ReadonlyArray<string>;
  readonly jump?: boolean;
}

/** Search the message model; only the bounded window containing a chosen match is mounted. */
export function TranscriptFind({
  scope,
  viewport,
  threadId,
  agentId,
  cloudKey,
  focused,
  blocks,
  live,
  history,
}: {
  readonly scope: RefObject<HTMLDivElement | null>;
  readonly viewport: RefObject<HTMLDivElement | null>;
  readonly threadId: string | undefined;
  readonly agentId?: AgentId | undefined;
  readonly cloudKey?: string | undefined;
  readonly focused: boolean;
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  readonly live?: ReadonlyMap<string, AgentEvent> | undefined;
  readonly history?: ThreadHistory | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [asked, setAsked] = useState(0);
  const [index, setIndex] = useState<ReadonlyArray<SearchMessage>>([]);
  const [readState, setReadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [pending, setPending] = useState<Pending>();
  const [artifact, setArtifact] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [overlay, setOverlay] = useState<ReadonlyMap<string, string>>(new Map());
  const input = useRef<HTMLInputElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const reading = useRef(false);
  const visibleFrames = useRef(0);
  const hidden = useKeptHidden();
  const jump = useAtomValue(findJumpAtom);
  const takeJump = useAtomSet(findJumpAtom);
  const read = useAtomSet(
    cloudKey
      ? readCloudSearchHistory(cloudKey)
      : readSearchHistory(JSON.stringify([threadId, agentId, null])),
    { mode: "promise" },
  );

  const active =
    open ||
    pending !== undefined ||
    (jump !== undefined && jump.threadId === threadId) ||
    artifact !== undefined;
  const messages = new Map((active ? index : []).map((message) => [message.id, message]));
  for (const message of active ? searchMessages(blocks) : []) {
    const previous = messages.get(message.id);
    messages.set(
      message.id,
      previous?.text === message.text
        ? previous
        : { ...message, ...(previous?.cursor ? { cursor: previous.cursor } : {}) },
    );
  }
  for (const [id, text] of overlay) {
    const previous = messages.get(id);
    if (previous) messages.set(id, { ...previous, text });
  }
  const all = [...messages.values()];
  const matches = modelMatches(all, query);
  const at = Math.max(0, Math.min(current, matches.length - 1));

  const ensureIndex = useEffectEvent((retry = false) => {
    if (
      reading.current ||
      readState === "ready" ||
      (readState === "error" && !retry) ||
      (agentId === undefined && cloudKey === undefined)
    )
      return;
    reading.current = true;
    setReadState("loading");
    void read(undefined)
      .then(
        (events) => {
          setIndex(
            messagesFromHistory(
              agentId === undefined ? events : events.filter((event) => event.agentId === agentId),
            ),
          );
          setReadState("ready");
        },
        () => setReadState("error"),
      )
      .finally(() => {
        reading.current = false;
      });
  });
  const navigate = useEffectEvent((target: Pending) => {
    visibleFrames.current = 0;
    setPending(target);
    window.dispatchEvent(new CustomEvent(HISTORY_EVENT, { detail: { id: target.message.id } }));
  });
  // A jump can precede the first page, or survive a restarted runtime. Use the current reader's
  // callback once it arrives instead of leaving the request attached to a disposed subscription.
  const loadThrough = history?.loadThrough;
  useEffect(() => {
    if (pending?.message.cursor) loadThrough?.(pending.message.cursor);
  }, [pending, loadThrough]);
  const go = (match: ModelMatch | undefined) => {
    if (match) navigate({ ...match, query });
  };

  const askFind = useEffectEvent(() => {
    if (!open) {
      const active = document.activeElement;
      returnTo.current = active instanceof HTMLElement ? active : null;
      setOpen(true);
    }
    ensureIndex(true);
    setAsked((value) => value + 1);
    go(matches[at]);
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

  // Locate only after model / DOM changes. A deep jump pages through a contiguous suffix; it never
  // forces all of those messages into the DOM or polls the entire thread every animation frame.
  const locate = useEffectEvent(() => {
    if (!pending || hidden) return false;
    const column = scope.current;
    if (!column) return false;
    const message = column.querySelector<HTMLElement>('[data-find="' + CSS.escape(pending.message.id) + '"]');
    if (!message) {
      visibleFrames.current = 0;
      window.dispatchEvent(new CustomEvent(HISTORY_EVENT, { detail: { id: pending.message.id } }));
      return false;
    }
    const ranges = wordRanges(message, pending.words ?? [pending.query]);
    let range = ranges[pending.ordinal] ?? ranges[0] ?? rangeOf(message);
    if (range.getBoundingClientRect().height === 0) range = rangeOf(message);
    const rect = range.getBoundingClientRect();
    const view = viewport.current;
    if (!view) return false;
    const fits = (bounds: DOMRect) =>
      rect.height > bounds.height
        ? rect.bottom > bounds.top && rect.top < bounds.bottom
        : rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
    let visible = fits(view.getBoundingClientRect());
    for (
      let parent = message.parentElement;
      visible && parent && parent !== view;
      parent = parent.parentElement
    ) {
      const overflow = getComputedStyle(parent).overflowY;
      if (overflow === "hidden" || overflow === "clip") visible = fits(parent.getBoundingClientRect());
    }
    if (!visible) {
      visibleFrames.current = 0;
      showRange(range, false);
      return false;
    }
    // A disclosure can contain the node while its clip is still opening. Finish only after two
    // frames of actual visibility, using a fresh Range each time rather than a stale text node.
    if (++visibleFrames.current < 2) return false;
    if (pending.jump) {
      ringMessage(message);
      if (ranges.length) markFor("find-jump", ranges);
      takeJump(undefined);
    }
    setPending(undefined);
    setRevision((value) => value + 1);
    return true;
  });
  useEffect(() => {
    if (!pending || hidden) return;
    window.dispatchEvent(new CustomEvent(HISTORY_EVENT, { detail: { id: pending.message.id } }));
    // A target inside an earlier version needs a few commits: mount its outer window, open the
    // disclosure, then mount its inner window. Retry only that bounded DOM during those commits.
    let frame = 0;
    let attempts = 0;
    const look = () => {
      if (!locate() && ++attempts < 120) frame = requestAnimationFrame(look);
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [pending, blocks, history?.pageRevision, hidden]);

  const rescan = useEffectEvent(() => {
    const text = new Map<string, string>();
    for (const [id, event] of live ?? []) {
      const payload = event.payload;
      if (payload._tag === "MessageDelta") text.set(id, payload.text);
    }
    setOverlay(text);
    setRevision((value) => value + 1);
    locate();
  });
  useEffect(() => {
    const column = scope.current;
    if (!column || (!open && !pending)) return;
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
  }, [open, pending, scope]);

  const followMatch = useEffectEvent(() => go(matches[at]));
  useEffect(() => {
    if (!open || query === "") return;
    const frame = requestAnimationFrame(() => followMatch());
    return () => cancelAnimationFrame(frame);
  }, [query, readState, open]);
  useEffect(() => {
    if (!open || !scope.current) return;
    const ranges = findRanges(scope.current, query);
    CSS.highlights.set("find", new Highlight(...ranges));
    const match = matches[at];
    const message =
      match && scope.current.querySelector('[data-find="' + CSS.escape(match.message.id) + '"]');
    const active = message && wordRanges(message, [query])[match.ordinal];
    if (active) CSS.highlights.set("find-current", new Highlight(active));
    else CSS.highlights.delete("find-current");
    return () => {
      CSS.highlights.delete("find");
      CSS.highlights.delete("find-current");
    };
  }, [open, query, current, revision, blocks, index, scope, at, matches]);

  const paletteJump = useEffectEvent(() => {
    if (hidden || !jump || jump.threadId !== threadId) return;
    ensureIndex();
    const id = jumpCandidates(all, jump.passage)[0];
    const message = id === undefined ? undefined : messages.get(id);
    if (message) navigate({ message, ordinal: 0, query: "", words: matchedWords(jump.passage), jump: true });
  });
  useEffect(() => {
    const frame = requestAnimationFrame(() => paletteJump());
    return () => cancelAnimationFrame(frame);
  }, [jump, threadId, hidden, readState]);

  const artifactJump = useEffectEvent(() => {
    if (!artifact || hidden) return;
    ensureIndex();
    const message = all.findLast((message) =>
      artifactBlocks(message.text).some((code) => artifactId(code) === artifact),
    );
    if (message) {
      navigate({ message, ordinal: 0, query: "" });
      setArtifact(undefined);
    }
  });
  useEffect(() => {
    const requested = (event: Event) => {
      const id = (event as CustomEvent<{ artifact?: string }>).detail?.artifact;
      if (id && scope.current?.checkVisibility()) setArtifact(id);
    };
    window.addEventListener(HISTORY_EVENT, requested);
    return () => window.removeEventListener(HISTORY_EVENT, requested);
  }, [scope]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => artifactJump());
    return () => cancelAnimationFrame(frame);
  }, [artifact, readState, hidden]);

  const close = () => {
    setOpen(false);
    setPending(undefined);
    const back = returnTo.current;
    returnTo.current = null;
    if (back?.isConnected) back.focus();
  };
  const step = (by: number) => {
    if (!matches.length) return;
    const next = (at + by + matches.length) % matches.length;
    setCurrent(next);
    go(matches[next]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      step(event.shiftKey || event.key === "ArrowUp" ? -1 : 1);
    }
  };
  if (!open) return null;
  const count =
    query === ""
      ? ""
      : readState === "loading"
        ? "Searching…"
        : matches.length === 0
          ? "No matches"
          : at + 1 + " / " + matches.length;
  return (
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
          setCurrent(0);
        }}
        placeholder="Find in thread"
        aria-label="Find in thread"
        className="w-40 min-w-0 bg-transparent outline-none placeholder:text-fg-tertiary max-md:text-base"
      />
      <output
        aria-live="polite"
        title={
          readState === "error" ? "Older messages couldn’t be searched. Close find and try again." : undefined
        }
        className="shrink-0 px-1.5 text-meta text-fg-tertiary tabular-nums"
      >
        {count}
        {pending ? " · Loading match…" : ""}
      </output>
      <Tooltip label="Previous match" shortcut="Shift Enter">
        <Button
          aria-label="Previous match"
          disabled={!matches.length}
          onClick={() => step(-1)}
          className={iconButton}
        >
          <ChevronUp size={15} strokeWidth={1.75} />
        </Button>
      </Tooltip>
      <Tooltip label="Next match" shortcut="Enter">
        <Button
          aria-label="Next match"
          disabled={!matches.length}
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
