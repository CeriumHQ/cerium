import type { Mention } from "@cerium/protocol";
import {
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";

import { baseName, fileIconSvg, skillIconSvg } from "../../components/fileIcons/index.ts";
import { spacedInsert } from "../dictation/model.ts";
import { chipClass } from "../transcript/FileChip.tsx";
import {
  appendSegments,
  normalizeSegments,
  triggerAt,
  withoutEnding,
  type Segment,
  type Trigger,
} from "./draft.ts";

export interface PromptEditorHandle {
  /** Replaces the tag being typed before the caret with a chip for `mention`. */
  insertMention(mention: Mention): void;
  /** Captures the slash command so a picker can replace it after focus leaves the editor. */
  captureSlashReplacement(): ((text: string, cursor?: number) => void) | undefined;
  /** Whether a collapsed caret is at the beginning of the editor. */
  atStart(): boolean;
  /** A chip for `mention` at the caret the editor last had (the end when none), then focus. */
  mentionAtCaret(mention: Mention): void;
  /**
   * `segments` after the content, on a line of their own, then focus with the caret at the end. A
   * `replacing` line the content ends with goes first.
   */
  append(segments: ReadonlyArray<Segment>, replacing?: string): void;
  /**
   * `text` at the caret the editor last had (the end when none), spaced from the words beside it,
   * then focus after it. Ctrl Z takes it back like typing.
   */
  insertText(text: string): void;
}

interface PromptEditorProps {
  /** The editable element, for callers that move focus to it. */
  readonly ref?: Ref<HTMLDivElement> | undefined;
  readonly handle: RefObject<PromptEditorHandle | null>;
  /** The editor is rebuilt from `segments` whenever this changes: another draft, or a cleared one. */
  readonly resetKey: string;
  readonly segments: ReadonlyArray<Segment>;
  readonly placeholder: string;
  readonly onChange: (segments: ReadonlyArray<Segment>) => void;
  /** The `@` or `$` tag being typed, whenever it changes; undefined when there is none. */
  readonly onTrigger: (trigger: Trigger | undefined) => void;
  /** Runs first; Enter that it leaves alone becomes a line break. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onFiles: (files: ReadonlyArray<File>) => void;
  /** The suggestion highlighted in the open `@`/`$` list, which keyboard focus stays beside. */
  readonly activeOption?: string | undefined;
  /** Sits on one row between the box's buttons, as while a phone's keyboard is up. */
  readonly inline?: boolean;
  /** Shown in place of the placeholder while the editor is empty, such as what a running turn is doing. */
  readonly cover?: ReactNode;
  /**
   * A line the user could send, drawn as ghost text while the editor is empty. It is only drawn:
   * the box that owns it decides what Tab does with it.
   */
  readonly suggestion?: string | undefined;
  readonly onAcceptSuggestion?: () => void;
  /** The user is about to change the text (typing, pasting, dropping, composing), before it reports. */
  readonly onEdit?: (() => void) | undefined;
}

const MENTION = "mention";

/** A chip the browser treats as one character: the caret steps over it and Backspace removes it whole. */
const chipElement = (mention: Mention): HTMLElement => {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset[MENTION] = JSON.stringify(mention);
  chip.className = `${chipClass} mx-px cursor-default select-none`;
  chip.title = mention._tag === "FileMention" ? mention.path : `Skill: ${mention.name}`;
  const icon = document.createElement("span");
  icon.className = "inline-grid size-[1.1em] shrink-0 place-items-center [&>svg]:size-full";
  // Cerium's own bundled icons.
  icon.innerHTML =
    mention._tag === "FileMention" ? fileIconSvg(mention.path, mention.folder) : skillIconSvg();
  const label = document.createElement("span");
  label.className = "min-w-0 truncate";
  label.textContent = mention._tag === "FileMention" ? baseName(mention.path) : mention.name;
  chip.append(icon, label);
  return chip;
};

const render = (root: HTMLElement, segments: ReadonlyArray<Segment>) =>
  root.replaceChildren(
    ...segments.map((segment) =>
      segment.kind === "text" ? document.createTextNode(segment.text) : chipElement(segment.mention),
    ),
  );

/** The editor's content as segments. Chrome may wrap lines in `div`s or end them with `br`s. */
const read = (root: HTMLElement): ReadonlyArray<Segment> => {
  const segments: Array<Segment> = [];
  const text = (value: string) => segments.push({ kind: "text", text: value.replaceAll(" ", " ") });
  const endsWithBreak = () => {
    const last = segments.at(-1);
    return last === undefined || (last.kind === "text" && last.text.endsWith("\n"));
  };
  const walk = (parent: Node) => {
    for (const node of parent.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text(node.textContent ?? "");
      } else if (node instanceof HTMLElement) {
        const mention = node.dataset[MENTION];
        if (mention !== undefined) {
          segments.push({ kind: "mention", mention: JSON.parse(mention) as Mention });
        } else if (node.tagName === "BR") {
          text("\n");
        } else {
          if ((node.tagName === "DIV" || node.tagName === "P") && !endsWithBreak()) text("\n");
          walk(node);
        }
      }
    }
  };
  walk(root);
  return normalizeSegments(segments);
};

/**
 * The tag being typed right before the caret. `/` only where the message starts: anything before the
 * caret's own text is blank. Read from the range, since replacing a selection can leave empty text
 * nodes before the one the caret sits in.
 */
const currentTrigger = (root: HTMLElement): Trigger | undefined => {
  const selection = document.getSelection();
  const node = selection?.anchorNode;
  if (!selection?.isCollapsed || node?.nodeType !== Node.TEXT_NODE || !root.contains(node)) return undefined;
  const before = (node.textContent ?? "").slice(0, selection.anchorOffset);
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, selection.anchorOffset);
  const fromStart = range.toString();
  const leading = before.length === 0 ? fromStart : fromStart.slice(0, -before.length);
  return triggerAt(before, /^\s*$/.test(leading));
};

const placeCaret = (range: Range) => {
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
};

const placeCaretAtEnd = (root: HTMLElement) => {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  placeCaret(range);
};

/** The node right before or after a collapsed range's position, stepping out of text nodes' ends. */
const besideCaret = (range: Range, side: "before" | "after"): Node | null => {
  const { startContainer: container, startOffset: offset } = range;
  if (container.nodeType === Node.TEXT_NODE) {
    const length = container.textContent?.length ?? 0;
    if (side === "before" ? offset > 0 : offset < length) return container;
    return side === "before" ? container.previousSibling : container.nextSibling;
  }
  return container.childNodes[side === "before" ? offset - 1 : offset] ?? null;
};

/**
 * The character right before (or after) the caret: undefined at an edge, a line break for a `br`,
 * and a letter for a chip, which reads as a word.
 */
const charBeside = (range: Range, side: "before" | "after"): string | undefined => {
  const node = besideCaret(range, side);
  if (node === null) return undefined;
  if (node instanceof HTMLElement) return node.tagName === "BR" ? "\n" : "x";
  const text = node.textContent ?? "";
  return node === range.startContainer
    ? text[side === "before" ? range.startOffset - 1 : range.startOffset]
    : side === "before"
      ? text.at(-1)
      : text[0];
};

/** Whether the caret sits after (or before) a space, a line break or an edge, not a word or chip. */
const spacedAt = (range: Range, side: "before" | "after"): boolean => {
  const char = charBeside(range, side);
  return char === undefined || /\s/.test(char);
};

/**
 * The message box's text: plain text, with each tagged file, folder or skill as an inline chip.
 * The DOM is the source of truth while typing; every change is reported as segments.
 */
export function PromptEditor({
  ref,
  handle,
  resetKey,
  segments,
  placeholder,
  onChange,
  onTrigger,
  onKeyDown,
  onFiles,
  activeOption,
  inline = false,
  cover,
  suggestion,
  onAcceptSuggestion,
  onEdit,
}: PromptEditorProps) {
  const root = useRef<HTMLDivElement>(null);
  const suggestionId = useId();
  /** Where the caret was last inside the editor, for chips added while the user is elsewhere. */
  const caret = useRef<Range>(null);

  const keepCaret = () => {
    const selection = document.getSelection();
    if (root.current && selection && selection.rangeCount > 0 && root.current.contains(selection.anchorNode))
      caret.current = selection.getRangeAt(0).cloneRange();
  };

  // Another draft, or this one cleared or given back: show it.
  const show = useEffectEvent(() => {
    if (root.current) render(root.current, segments);
  });
  useEffect(() => {
    show();
  }, [resetKey]);

  // The draft changed elsewhere, in another tab or on another device: show it, the caret at its end.
  // What the editor reported itself always matches what it shows.
  const follow = useEffectEvent(() => {
    const element = root.current;
    if (!element || JSON.stringify(read(element)) === JSON.stringify(segments)) return;
    const focused = document.activeElement === element;
    render(element, segments);
    if (focused) placeCaretAtEnd(element);
  });
  useEffect(() => {
    follow();
  }, [segments]);

  const report = () => {
    if (!root.current) return;
    onEdit?.();
    keepCaret();
    onChange(read(root.current));
    onTrigger(currentTrigger(root.current));
  };

  useImperativeHandle(handle, () => ({
    insertMention: (mention) => {
      const element = root.current;
      const selection = document.getSelection();
      const node = selection?.anchorNode;
      if (!element || !selection || node?.nodeType !== Node.TEXT_NODE || !element.contains(node)) return;
      const trigger = triggerAt((node.textContent ?? "").slice(0, selection.anchorOffset));
      if (trigger === undefined) return;
      const range = document.createRange();
      range.setStart(node, trigger.start);
      range.setEnd(node, selection.anchorOffset);
      range.deleteContents();
      // A space after the chip gives the caret somewhere to go that isn't inside it.
      const space = document.createTextNode(" ");
      range.insertNode(space);
      range.insertNode(chipElement(mention));
      const caret = document.createRange();
      caret.setStart(space, 1);
      caret.collapse(true);
      selection.removeAllRanges();
      selection.addRange(caret);
      report();
    },
    captureSlashReplacement: () => {
      const element = root.current;
      const selection = document.getSelection();
      const active =
        element && selection?.rangeCount && element.contains(selection.anchorNode)
          ? selection.getRangeAt(0)
          : caret.current;
      const node = active?.startContainer;
      if (!element || !active?.collapsed || node?.nodeType !== Node.TEXT_NODE || !element.contains(node))
        return undefined;
      const original = node.textContent ?? "";
      const end = active.startOffset;
      const trigger = triggerAt(original.slice(0, end), true);
      if (trigger?.char !== "/") return undefined;
      return (text, cursor = text.length) => {
        if (root.current !== element || !element.contains(node) || node.textContent !== original) return;
        const range = document.createRange();
        range.setStart(node, trigger.start);
        range.setEnd(node, end);
        range.deleteContents();
        const inserted = document.createTextNode(text);
        range.insertNode(inserted);
        element.focus();
        range.setStart(inserted, cursor);
        range.collapse(true);
        placeCaret(range);
        report();
      };
    },
    atStart: () => {
      const element = root.current;
      const selection = document.getSelection();
      if (!element || !selection?.isCollapsed || !element.contains(selection.anchorNode)) return false;
      if (element.childNodes.length === 1 && element.firstElementChild?.tagName === "BR") return true;
      const before = selection.getRangeAt(0).cloneRange();
      before.setStart(element, 0);
      // A trailing <br> is an empty editor, but a line break before the caret is a real line.
      const content = before.cloneContents();
      return (content.textContent ?? "") === "" && content.querySelector("br") === null;
    },
    mentionAtCaret: (mention) => {
      const element = root.current;
      if (!element) return;
      // The saved caret is gone once the draft was rebuilt, such as after sending.
      const saved = caret.current;
      const range = saved && element.contains(saved.startContainer) ? saved.cloneRange() : undefined;
      const at = range ?? document.createRange();
      if (range === undefined) {
        at.selectNodeContents(element);
        at.collapse(false);
      }
      at.deleteContents();
      // A space after the chip also gives the caret somewhere to go at the end that isn't inside it.
      const spaceAfter = besideCaret(at, "after") === null || !spacedAt(at, "after");
      const spaceBefore = !spacedAt(at, "before");
      // Inserting at a collapsed range puts each node before the ones inserted earlier.
      const after = spaceAfter ? document.createTextNode(" ") : undefined;
      if (after) at.insertNode(after);
      const chip = chipElement(mention);
      at.insertNode(chip);
      if (spaceBefore) at.insertNode(document.createTextNode(" "));
      element.focus();
      const end = document.createRange();
      if (after) end.setStart(after, 1);
      else end.setStartAfter(chip);
      end.collapse(true);
      placeCaret(end);
      report();
    },
    append: (added, replacing) => {
      const element = root.current;
      if (!element) return;
      const current = read(element);
      render(
        element,
        appendSegments(replacing === undefined ? current : withoutEnding(current, replacing), added),
      );
      element.focus();
      placeCaretAtEnd(element);
      element.scrollTop = element.scrollHeight;
      report();
    },
    insertText: (text) => {
      const element = root.current;
      if (!element) return;
      const saved = caret.current;
      const range = saved && element.contains(saved.startContainer) ? saved.cloneRange() : undefined;
      const at = range ?? document.createRange();
      if (range === undefined) {
        at.selectNodeContents(element);
        at.collapse(false);
      }
      element.focus();
      placeCaret(at);
      const spaced = spacedInsert(text, charBeside(at, "before"), charBeside(at, "after"));
      // The editor's own undo history takes it, as it does typing and pasting.
      document.execCommand("insertText", false, spaced);
      keepCaret();
    },
  }));

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Only plain text: no bold, italics or underline.
    if ((event.ctrlKey || event.metaKey) && ["b", "i", "u"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      return;
    }
    onKeyDown(event);
    if (event.defaultPrevented || event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    document.execCommand("insertLineBreak");
  };

  const paste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = [...event.clipboardData.files];
    if (files.length > 0) {
      onFiles(files);
      return;
    }
    document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
  };

  // Clearing an editable box can leave a bare line break behind; that still counts as empty.
  const empty = segments.every(
    (segment) => segment.kind === "text" && segment.text.replace(/\n/g, "") === "",
  );

  // The ghost stands where the placeholder would, and only while nothing else covers the empty line.
  const ghost = empty && suggestion !== undefined && !cover;

  return (
    <div
      className={`prompt-editor group/editor ${ghost ? "grid" : ""} ${inline ? "relative min-w-0 flex-1" : "relative"}`}
    >
      <div
        ref={(element) => {
          root.current = element;
          if (typeof ref === "function") ref(element);
          else if (ref) ref.current = element;
        }}
        // A <textarea> can't hold the mention chips this editable box does.
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="textbox"
        // The message glides from where it starts on one line to where it starts in the open box.
        data-morph="message"
        tabIndex={0}
        aria-multiline
        aria-label="Message"
        aria-placeholder={placeholder}
        aria-autocomplete="list"
        aria-controls={
          activeOption === undefined
            ? undefined
            : activeOption.startsWith("slash-")
              ? "slash-menu"
              : "mention-menu"
        }
        aria-describedby={ghost ? suggestionId : undefined}
        aria-activedescendant={activeOption}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        onInput={report}
        // Anything that changes the text ends a suggestion, IME composition included, which reports
        // only once it has put its first characters in.
        onBeforeInput={() => onEdit?.()}
        onCompositionStart={() => onEdit?.()}
        onSelect={() => {
          keepCaret();
          if (root.current) onTrigger(currentTrigger(root.current));
        }}
        onKeyDown={keyDown}
        onPaste={paste}
        // Dropped text arrives as plain text; dropped files are handled by the box around the editor.
        onDrop={(event) => {
          if (event.dataTransfer.files.length > 0) return;
          event.preventDefault();
          const range = document.caretRangeFromPoint(event.clientX, event.clientY);
          if (range) {
            document.getSelection()?.removeAllRanges();
            document.getSelection()?.addRange(range);
          }
          document.execCommand("insertText", false, event.dataTransfer.getData("text/plain"));
        }}
        // Focus from elsewhere (a shortcut, opening a thread) continues at the end of the draft.
        onFocus={() => {
          const selection = document.getSelection();
          if (root.current && !root.current.contains(selection?.anchorNode ?? null))
            placeCaretAtEnd(root.current);
        }}
        onBlur={() => onTrigger(undefined)}
        className={`${ghost ? "col-start-1 row-start-1" : ""} block w-full overflow-y-auto text-reading leading-[1.6] break-words whitespace-pre-wrap text-fg-primary outline-none max-md:text-[16px] ${
          inline
            ? "max-h-32 min-h-(--line-row) px-1 py-(--line-pad) md:max-h-60"
            : "max-h-60 min-h-12 px-4 pt-3 pb-1 max-md:max-h-40"
        }`}
      />
      {empty && cover ? (
        // Pointing at the line or writing in it trades the cover for the placeholder, so the box says
        // it takes a message even while it shows something else.
        <div className="pointer-events-none absolute inset-y-0 inset-x-1 flex min-w-0 items-center transition-opacity duration-150 group-hover/editor:opacity-0 group-focus-within/editor:opacity-0">
          {cover}
        </div>
      ) : null}
      {ghost ? (
        // Read out as the textbox's description, so a screen reader hears it and how to take it.
        <span
          data-followup=""
          className={`pointer-events-none col-start-1 row-start-1 flex min-w-0 items-baseline gap-2 text-reading leading-[1.6] text-fg-tertiary select-none max-md:text-[16px] ${
            inline ? "px-1 py-(--line-pad)" : "px-4 pt-3 pb-1"
          }`}
        >
          <span id={suggestionId} className="min-w-0 break-words">
            {suggestion}
            <span className="sr-only"> Press Tab to use this suggestion, or Escape to dismiss it.</span>
          </span>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Accept suggestion"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onAcceptSuggestion}
            className="pointer-events-auto shrink-0 cursor-pointer rounded-[5px] border border-line-subtle px-1.5 font-sans text-caption leading-[1.4] text-fg-tertiary hover:text-fg-primary"
          >
            <span className="pointer-coarse:hidden">Tab</span>
            <span className="hidden pointer-coarse:inline">Use</span>
          </button>
        </span>
      ) : null}
      {empty ? (
        <span
          aria-hidden
          data-editor-placeholder=""
          className={`pointer-events-none absolute text-reading leading-[1.6] text-fg-tertiary select-none max-md:text-[16px] ${
            inline ? "inset-x-1 top-(--line-pad) truncate" : "top-3 left-4"
          } ${cover ? "opacity-0 transition-opacity duration-150 group-hover/editor:opacity-100 group-focus-within/editor:opacity-100" : ""}`}
        >
          {placeholder}
        </span>
      ) : null}
    </div>
  );
}
