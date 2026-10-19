import { Button } from "@base-ui/react/button";
import { Monitor, Paperclip, PenLine, Trash2 } from "lucide-react";

import { MenuItem } from "../../components/ui/Menu.tsx";
import type { NewThreadDraft } from "../composer/drafts.ts";
import { moreRoom, RowFrame, yieldsToMore } from "./RowFrame.tsx";
import type { RowMark } from "./ThreadRow.tsx";

/** The computer a draft starts on, when it isn't this one. */
export type DraftMachine = (machine: string | undefined) => { name: string; online: boolean } | undefined;

export interface DraftActions {
  readonly selectedId: string | undefined;
  readonly onSelectDraft: (draft: NewThreadDraft, newTab?: boolean) => void;
  readonly onDiscardDraft: (key: string) => void;
  readonly draftMachine: DraftMachine;
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * A thread not started yet. Unlike a thread's badge, its tile is an outline drawn in dashes around a
 * pen: nothing has been sent, and nothing runs.
 */
function DraftMark({ mark }: { mark: RowMark }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-[5px] border border-dashed border-fg-tertiary/70 text-fg-tertiary ${
        // A bare status dot's slot is 12px; the tile overhangs it a little, so titles stay aligned.
        mark === "badge" ? "size-4.5" : "-mx-0.5 size-4 rounded-[4px]"
      }`}
    >
      <PenLine size={mark === "badge" ? 10 : 9} strokeWidth={2} />
    </span>
  );
}

/** A draft's row in the inbox or the chat list: a line, with a menu that offers to throw it away. */
export function DraftRow({
  draft,
  mark,
  selectedId,
  onSelectDraft,
  onDiscardDraft,
  draftMachine,
}: { draft: NewThreadDraft; mark: RowMark } & DraftActions) {
  const selected = draft.key === selectedId;
  const machine = draftMachine(draft.machine);
  const place = [machine?.name, draft.folder ? baseName(draft.folder) : undefined].filter(Boolean);
  return (
    <RowFrame
      label={draft.title}
      menu={
        <MenuItem icon={Trash2} tone="danger" onClick={() => onDiscardDraft(draft.key)}>
          Discard draft
        </MenuItem>
      }
    >
      <Button
        onClick={(event) => onSelectDraft(draft, event.ctrlKey || event.metaKey)}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        onAuxClick={(event) => {
          if (event.button === 1) onSelectDraft(draft, true);
        }}
        data-draft={draft.key}
        aria-current={selected ? "page" : undefined}
        aria-label={`Draft: ${draft.title}`}
        // Where it will start, for a row too narrow to say.
        title={
          place.length > 0
            ? `${draft.title}
${place.join(" · ")}`
            : draft.title
        }
        className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 data-popup-open:bg-surface-hover max-md:h-11 max-md:gap-3 max-md:rounded-lg max-md:text-[15px] ${moreRoom} ${
          selected
            ? "bg-surface-selected text-fg-primary"
            : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
        }`}
      >
        <span className="grid shrink-0 place-items-center">
          <DraftMark mark={mark} />
        </span>
        <span className={`min-w-0 flex-1 truncate ${draft.untitled ? "italic" : ""}`}>{draft.title}</span>
        {machine ? (
          <span
            title={`On ${machine.name}`}
            className={`shrink-0 text-fg-tertiary ${machine.online ? "" : "opacity-60"}`}
          >
            <Monitor size={11} strokeWidth={2} aria-label={`On ${machine.name}`} />
          </span>
        ) : null}
        {draft.attachments > 0 ? (
          <span
            className={`flex shrink-0 items-center gap-0.5 text-2xs text-fg-tertiary tabular-nums ${yieldsToMore}`}
            title={`${draft.attachments} attached file${draft.attachments === 1 ? "" : "s"}`}
          >
            <Paperclip size={10} strokeWidth={2} aria-hidden />
            {draft.attachments}
          </span>
        ) : null}
      </Button>
    </RowFrame>
  );
}

/** The drafts of threads not started yet, under their own heading. */
export function DraftSection({
  drafts,
  list,
  mark,
  ...actions
}: {
  drafts: ReadonlyArray<NewThreadDraft>;
  /** Which list it's in: the chat list's headings sit beside a chevron. */
  list: "inbox" | "chat";
  mark: RowMark;
} & DraftActions) {
  if (drafts.length === 0) return null;
  return (
    <section aria-label="Drafts">
      <h3
        className={`flex items-center gap-1.5 text-xs font-medium text-fg-secondary/80 ${
          list === "inbox" ? "px-2 pb-1" : "px-1.5 py-1 max-md:py-2 max-md:text-[13px]"
        }`}
      >
        Drafts
        <span className="text-fg-tertiary tabular-nums">{drafts.length}</span>
      </h3>
      <ul className="flex flex-col gap-px">
        {drafts.map((draft) => (
          <li key={draft.key}>
            <DraftRow draft={draft} mark={mark} {...actions} />
          </li>
        ))}
      </ul>
    </section>
  );
}
