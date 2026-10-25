import { Popover } from "@base-ui/react/popover";
import type { StashEntry } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { Archive, ArchiveRestore, Ellipsis, Trash2 } from "lucide-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";

import { stashListAtom } from "../../../backend/branches.ts";
import { MenuItem, MenuPopup, MenuRoot, MenuSeparator, MenuTrigger } from "../../../components/ui/Menu.tsx";
import { Tooltip } from "../../../components/ui/Tooltip.tsx";
import { shortAgo } from "../../../lib/time.ts";
import type { BranchDialog } from "./BranchDialogs.tsx";
import type { BranchControls } from "./useBranchControls.ts";

/**
 * What was put aside: a button with the count, shown once there is a stash or something to stash,
 * and a list to apply, pop or drop each one from.
 */
export function StashMenu({
  root,
  controls,
  onAsk,
}: {
  readonly root: string;
  readonly controls: BranchControls;
  readonly onAsk: (dialog: BranchDialog) => void;
}) {
  const result = useAtomValue(stashListAtom(root));
  const stashes = Option.getOrUndefined(AsyncResult.value(result)) ?? [];
  const state = controls.state;
  const changes = state?.changes ?? 0;
  if (state === undefined || !state.repository || (stashes.length === 0 && changes === 0)) return null;
  return (
    <Popover.Root>
      <Tooltip label="Stash" side="bottom">
        <Popover.Trigger
          aria-label={stashes.length === 0 ? "Stash" : `Stash, ${stashes.length} saved`}
          className="relative grid size-7 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors outline-none hover:bg-surface-hover hover:text-fg-secondary data-popup-open:bg-surface-active data-popup-open:text-fg-primary max-md:size-10"
        >
          <Archive size={15} strokeWidth={1.75} />
          {stashes.length === 0 ? null : (
            <span className="absolute -top-0.5 -right-0.5 grid min-w-3.5 place-items-center rounded-full bg-surface-selected px-1 text-[10px] leading-[14px] text-fg-primary tabular-nums">
              {stashes.length}
            </span>
          )}
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4} className="z-50 outline-none">
          <Popover.Popup
            aria-label="Stash"
            className="flex max-h-(--available-height) w-80 max-w-[calc(100vw-1rem)] origin-(--transform-origin) flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0"
          >
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
              {stashes.length === 0 ? (
                <p className="px-2 py-3 text-meta text-fg-tertiary">Nothing is stashed.</p>
              ) : (
                stashes.map((entry) => (
                  <Entry key={entry.commit} entry={entry} controls={controls} onAsk={onAsk} />
                ))
              )}
            </div>
            {changes === 0 ? null : (
              <Popover.Close
                onClick={() => onAsk({ kind: "stash" })}
                className="flex h-9 shrink-0 items-center gap-2 border-t border-line-subtle px-3 text-body text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary max-md:h-12 max-md:text-[15px]"
              >
                <Archive size={14} strokeWidth={1.75} />
                Stash changes…
              </Popover.Close>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Entry({
  entry,
  controls,
  onAsk,
}: {
  readonly entry: StashEntry;
  readonly controls: BranchControls;
  readonly onAsk: (dialog: BranchDialog) => void;
}) {
  const busy = controls.busy !== undefined;
  return (
    <div className="group flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-surface-hover max-md:py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body text-fg-primary max-md:text-[15px]">{entry.message}</span>
        <span className="truncate text-caption text-fg-tertiary">
          {entry.branch === undefined ? "" : `${entry.branch} · `}
          {shortAgo(entry.at * 1000)}
        </span>
      </div>
      <MenuRoot>
        <MenuTrigger>
          <button
            type="button"
            aria-label={`Actions for ${entry.message}`}
            className="grid size-6 shrink-0 place-items-center rounded-md text-fg-tertiary opacity-0 transition-opacity outline-none group-hover:opacity-100 hover:bg-surface-active hover:text-fg-primary focus-visible:opacity-100 data-popup-open:opacity-100 max-md:size-9 max-md:opacity-100"
          >
            <Ellipsis size={14} strokeWidth={1.75} />
          </button>
        </MenuTrigger>
        <MenuPopup side="bottom" align="end">
          <MenuItem
            icon={ArchiveRestore}
            disabled={busy}
            onClick={() => void controls.applyStash(entry.commit, false)}
          >
            Apply
          </MenuItem>
          <MenuItem
            icon={ArchiveRestore}
            disabled={busy}
            onClick={() => void controls.applyStash(entry.commit, true)}
          >
            Apply and drop
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={Trash2}
            tone="danger"
            onClick={() => onAsk({ kind: "drop", commit: entry.commit, message: entry.message })}
          >
            Drop…
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
    </div>
  );
}
