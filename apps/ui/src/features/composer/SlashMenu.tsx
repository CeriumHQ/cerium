import type { SavedPrompt } from "@cerium/protocol";
import { Bookmark, CornerDownLeft } from "lucide-react";
import { useEffect, useRef } from "react";

import { keyLabel } from "../../lib/keys.ts";
import type { PaletteCommand } from "../palette/palette.ts";
import { scopeLabel } from "./prompts.ts";

// The list above the message box while a `/` command is being typed: the user's saved prompts,
// which insert their text, then the actions that run at once. Keyboard focus stays in the editor.

export type SlashEntry =
  | { readonly kind: "prompt"; readonly prompt: SavedPrompt }
  | { readonly kind: "action"; readonly command: PaletteCommand };

export interface SlashGroup {
  readonly value: string;
  readonly items: ReadonlyArray<SlashEntry>;
}

/** The prompts that answered and the actions that did, each under their heading. */
export const slashGroups = (
  prompts: ReadonlyArray<SavedPrompt>,
  actions: ReadonlyArray<PaletteCommand>,
): ReadonlyArray<SlashGroup> =>
  [
    { value: "Saved prompts", items: prompts.map((prompt): SlashEntry => ({ kind: "prompt", prompt })) },
    { value: "Actions", items: actions.map((command): SlashEntry => ({ kind: "action", command })) },
  ].filter((group) => group.items.length > 0);

type SlashRow =
  | { readonly kind: "heading"; readonly key: string; readonly value: string }
  | { readonly kind: "entry"; readonly key: string; readonly entry: SlashEntry };

export function SlashMenu({
  groups,
  query,
  active,
  onActive,
  onPick,
}: {
  groups: ReadonlyArray<SlashGroup>;
  query: string;
  /** The entry highlighted, over the prompts then the actions. */
  active: number;
  onActive: (index: number) => void;
  onPick: (entry: SlashEntry) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // The rows in order: each group's heading, then its entries, so the highlight moves over them all.
  const rows: ReadonlyArray<SlashRow> = groups.flatMap((group) => [
    { kind: "heading" as const, key: `heading:${group.value}`, value: group.value },
    ...group.items.map((entry): SlashRow => ({
      kind: "entry" as const,
      key: entry.kind === "prompt" ? `prompt:${entry.prompt.id}` : `action:${entry.command.id}`,
      entry,
    })),
  ]);
  const empty = query === "" ? "Type to narrow the list." : `Nothing matches “${query}”.`;
  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-full z-10 mb-2 overflow-hidden rounded-xl border border-line-subtle bg-surface-overlay shadow-overlay backdrop-blur-2xl">
      {/* The editor keeps focus and points into this list, which a <select> can't be. */}
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role */}
      <div ref={list} id="slash-menu" role="listbox" className="max-h-64 overflow-y-auto px-1 py-1">
        {rows.map((row, at) =>
          row.kind === "heading" ? (
            <p key={row.key} className="px-2 pt-2 pb-0.5 text-caption font-medium text-fg-tertiary">
              {row.value}
            </p>
          ) : (
            <SlashOption
              key={row.key}
              at={at}
              selected={at === active}
              entry={row.entry}
              onActive={onActive}
              onPick={onPick}
            />
          ),
        )}
        {rows.length === 0 ? <p className="px-2 py-1.5 text-meta text-fg-tertiary">{empty}</p> : null}
      </div>
    </div>
  );
}

/** One prompt or action the arrows move over, picked with the mouse without taking focus. */
function SlashOption({
  at,
  selected,
  entry,
  onActive,
  onPick,
}: {
  at: number;
  selected: boolean;
  entry: SlashEntry;
  onActive: (index: number) => void;
  onPick: (entry: SlashEntry) => void;
}) {
  return (
    <div
      id={`slash-option-${at}`}
      data-index={at}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      // Keeps focus, and the caret, in the editor.
      onMouseDown={(event) => {
        event.preventDefault();
        onPick(entry);
      }}
      onMouseMove={() => onActive(at)}
      className={`flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-body ${
        selected ? "bg-surface-active text-fg-primary" : "text-fg-secondary"
      }`}
    >
      {entry.kind === "prompt" ? (
        <>
          <Bookmark size={14} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
          <span className="shrink-0 font-medium text-fg-primary">{entry.prompt.name}</span>
          {scopeLabel(entry.prompt) === undefined ? null : (
            <span className="min-w-0 truncate text-meta text-fg-tertiary">{scopeLabel(entry.prompt)}</span>
          )}
          <CornerDownLeft size={12} strokeWidth={1.75} className="ml-auto shrink-0 text-fg-tertiary" />
        </>
      ) : (
        <>
          <entry.command.icon
            size={14}
            strokeWidth={1.75}
            className="shrink-0 text-fg-tertiary"
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate font-medium text-fg-primary">{entry.command.label}</span>
          {entry.command.keys === undefined ? null : (
            <kbd className="shrink-0 font-sans text-caption text-fg-tertiary">
              {keyLabel(entry.command.keys)}
            </kbd>
          )}
        </>
      )}
    </div>
  );
}
