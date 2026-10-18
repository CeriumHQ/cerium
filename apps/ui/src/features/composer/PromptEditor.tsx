import type { Mention } from "@cerium/protocol";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from "react";

import { baseName, fileIconSvg, skillIconSvg } from "../../components/fileIcons/index.ts";
import { chipClass } from "../transcript/FileChip.tsx";
import { normalizeSegments, triggerAt, type Segment, type Trigger } from "./draft.ts";

export interface PromptEditorHandle {
  /** Replaces the tag being typed before the caret with a chip for `mention`. */
  insertMention(mention: Mention): void;
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

/** The tag being typed right before the caret. */
const currentTrigger = (root: HTMLElement): Trigger | undefined => {
  const selection = document.getSelection();
  const node = selection?.anchorNode;
  if (!selection?.isCollapsed || node?.nodeType !== Node.TEXT_NODE || !root.contains(node)) return undefined;
  return triggerAt((node.textContent ?? "").slice(0, selection.anchorOffset));
};

const placeCaretAtEnd = (root: HTMLElement) => {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
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
}: PromptEditorProps) {
  const root = useRef<HTMLDivElement>(null);

  // Another draft, or this one cleared or given back: show it.
  const show = useEffectEvent(() => {
    if (root.current) render(root.current, segments);
  });
  useEffect(() => {
    show();
  }, [resetKey]);

  const report = () => {
    if (!root.current) return;
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

  return (
    <div className="relative">
      <div
        ref={(element) => {
          root.current = element;
          if (typeof ref === "function") ref(element);
          else if (ref) ref.current = element;
        }}
        role="textbox"
        tabIndex={0}
        aria-multiline
        aria-label="Message"
        aria-placeholder={placeholder}
        aria-autocomplete="list"
        aria-controls={activeOption === undefined ? undefined : "mention-menu"}
        aria-activedescendant={activeOption}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        onInput={report}
        onSelect={() => root.current && onTrigger(currentTrigger(root.current))}
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
        className="block max-h-60 min-h-12 w-full overflow-y-auto px-4 pt-3 pb-1 text-[14px] leading-[1.6] break-words whitespace-pre-wrap text-fg-primary outline-none"
      />
      {segments.length === 0 ? (
        <span
          aria-hidden
          className="pointer-events-none absolute top-3 left-4 text-[14px] leading-[1.6] text-fg-tertiary select-none"
        >
          {placeholder}
        </span>
      ) : null}
    </div>
  );
}
