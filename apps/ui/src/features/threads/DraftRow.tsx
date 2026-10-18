import { Button } from "@base-ui/react/button";
import { Monitor, Paperclip, PenLine, Trash2 } from "lucide-react";

import { ContextMenuArea, MenuItem } from "../../components/ui/Menu.tsx";
import type { NewThreadDraft } from "../composer/drafts.ts";

/** The computer a draft starts on, when it isn't this one. */
export type DraftMachine = (machine: string | undefined) => { name: string; online: boolean } | undefined;

export interface DraftActions {
  readonly selectedId: string | undefined;
  readonly onSelectDraft: (draft: NewThreadDraft) => void;
  readonly onDiscardDraft: (key: string) => void;
  readonly draftMachine: DraftMachine;
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * A thread not started yet. Unlike a thread's badge, its tile is an outline drawn in dashes around a
 * pen: nothing has been sent, and nothing runs.
 */
function DraftMark({ size }: { size: "inbox" | "chat" }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-[5px] border border-dashed border-fg-tertiary/70 text-fg-tertiary ${
        // The chat list's tile overhangs its 12px status slot a little, so titles stay aligned.
        size === "inbox" ? "mt-px size-4.5 max-md:size-5" : "-mx-0.5 size-4 rounded-[4px]"
      }`}
    >
      <PenLine size={size === "inbox" ? 10 : 9} strokeWidth={2} />
    </span>
  );
}

/** A draft's row in the inbox or the chat list; right-clicking offers to throw it away. */
export function DraftRow({
  draft,
  layout,
  selectedId,
  onSelectDraft,
  onDiscardDraft,
  draftMachine,
}: { draft: NewThreadDraft; layout: "inbox" | "chat" } & DraftActions) {
  const selected = draft.key === selectedId;
  const machine = draftMachine(draft.machine);
  const tone = selected
    ? "bg-surface-selected text-fg-primary"
    : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary";
  const title = (
    <span
      className={`min-w-0 flex-1 truncate ${draft.untitled ? "italic" : ""} ${
        layout === "inbox" ? "text-[13px] leading-5 max-md:text-[15px] max-md:leading-6" : ""
      }`}
    >
      {draft.title}
    </span>
  );
  const files =
    draft.attachments > 0 ? (
      <span
        className="flex shrink-0 items-center gap-0.5 text-fg-tertiary tabular-nums"
        title={`${draft.attachments} attached file${draft.attachments === 1 ? "" : "s"}`}
      >
        <Paperclip size={10} strokeWidth={2} aria-hidden />
        {draft.attachments}
      </span>
    ) : null;

  const row =
    layout === "inbox" ? (
      <Button
        onClick={() => onSelectDraft(draft)}
        aria-current={selected ? "page" : undefined}
        aria-label={`Draft: ${draft.title}`}
        className={`flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 data-popup-open:bg-surface-hover max-md:gap-3 max-md:rounded-lg max-md:py-2.5 ${tone}`}
      >
        <DraftMark size="inbox" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">{title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-2xs text-fg-tertiary max-md:text-xs">
            <span className="shrink-0 text-[9.5px] font-semibold tracking-[0.08em] uppercase max-md:text-[11px]">
              Draft
            </span>
            {machine ? (
              <span
                className={`flex min-w-0 shrink items-center gap-1 ${machine.online ? "" : "opacity-60"}`}
                title={`On ${machine.name}`}
              >
                <Monitor size={10} strokeWidth={2} className="shrink-0" />
                <span className="truncate">{machine.name}</span>
              </span>
            ) : null}
            <span aria-hidden className="text-fg-disabled">
              ·
            </span>
            <span className={`min-w-0 truncate ${draft.folder ? "" : "italic"}`}>
              {draft.folder ? baseName(draft.folder) : "No project yet"}
            </span>
            {files ? <span className="ml-auto pl-1">{files}</span> : null}
          </span>
        </span>
      </Button>
    ) : (
      <Button
        onClick={() => onSelectDraft(draft)}
        aria-current={selected ? "page" : undefined}
        aria-label={`Draft: ${draft.title}`}
        className={`group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 data-popup-open:bg-surface-hover max-md:h-11 max-md:gap-2.5 max-md:rounded-lg max-md:text-[15px] ${tone}`}
      >
        <span className="grid size-3 shrink-0 place-items-center">
          <DraftMark size="chat" />
        </span>
        {title}
        {machine ? (
          <span title={`On ${machine.name}`} className="shrink-0 text-fg-tertiary">
            <Monitor size={11} strokeWidth={2} aria-label={`On ${machine.name}`} />
          </span>
        ) : null}
        <span className="shrink-0 text-2xs">{files}</span>
      </Button>
    );

  return (
    <ContextMenuArea
      menu={
        <MenuItem icon={Trash2} tone="danger" onClick={() => onDiscardDraft(draft.key)}>
          Discard draft
        </MenuItem>
      }
    >
      {row}
    </ContextMenuArea>
  );
}

/** The drafts of threads not started yet, under their own heading. */
export function DraftSection({
  drafts,
  layout,
  ...actions
}: { drafts: ReadonlyArray<NewThreadDraft>; layout: "inbox" | "chat" } & DraftActions) {
  if (drafts.length === 0) return null;
  return (
    <section aria-label="Drafts">
      <h3
        className={`flex items-center gap-1.5 text-xs font-medium text-fg-secondary/80 ${
          layout === "inbox" ? "px-2 pb-1" : "px-1.5 py-1 max-md:py-2 max-md:text-[13px]"
        }`}
      >
        Drafts
        <span className="text-fg-tertiary tabular-nums">{drafts.length}</span>
      </h3>
      <ul className="flex flex-col gap-px">
        {drafts.map((draft) => (
          <li key={draft.key}>
            <DraftRow draft={draft} layout={layout} {...actions} />
          </li>
        ))}
      </ul>
    </section>
  );
}
