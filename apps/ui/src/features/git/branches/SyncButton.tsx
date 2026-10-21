import { useAtomValue } from "@effect/atom-react";
import { ArrowDown, ArrowUp, ChevronDown, CloudUpload, LoaderCircle, RefreshCw } from "lucide-react";
import { useState } from "react";

import { fetchedAtAtom } from "../../../backend/branches.ts";
import { MenuItem, MenuPopup, MenuRoot, MenuSeparator, MenuTrigger } from "../../../components/ui/Menu.tsx";
import { Tooltip } from "../../../components/ui/Tooltip.tsx";
import { whenAgo } from "../../../lib/time.ts";
import type { BranchDialog } from "./BranchDialogs.tsx";
import { fetchedNote, syncHint, syncLabel, syncPlan, type SyncAction } from "./model.ts";
import type { BranchControls } from "./useBranchControls.ts";

const icons = { fetch: RefreshCw, pull: ArrowDown, push: ArrowUp, publish: CloudUpload } as const;

/**
 * The button that keeps the branch level with its remote: what it does is what the branch needs
 * (pull when behind, push when ahead, publish when the remote has none), with the rest in its menu.
 */
export function SyncButton({
  root,
  controls,
  onAsk,
}: {
  readonly root: string;
  readonly controls: BranchControls;
  readonly onAsk: (dialog: BranchDialog) => void;
}) {
  const state = controls.state;
  if (state === undefined) return null;
  const plan = syncPlan(state);
  if (plan.hidden) return null;
  const busy = controls.busy !== undefined;
  const syncing = controls.busy === "fetch" || controls.busy === "pull" || controls.busy === "push";
  const Icon = icons[plan.primary];
  const label = syncLabel(plan);
  const run = (action: SyncAction) => {
    if (action === "fetch") void controls.fetch();
    else if (action === "pull") void controls.pull();
    else void controls.push(action === "publish" ? "publish" : "push");
  };
  const quiet = plan.primary === "fetch";
  return (
    <div className="flex shrink-0 items-center">
      <Tooltip label={<Hint root={root} hint={syncHint(plan, state.upstream?.name)} />} side="bottom">
        <button
          type="button"
          disabled={busy}
          aria-label={label}
          onClick={() => run(plan.primary)}
          className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors select-none hover:bg-surface-hover disabled:opacity-60 max-md:h-10 max-md:px-3 max-md:text-[15px] @max-[15rem]:gap-1 @max-[15rem]:px-1.5 ${
            quiet ? "text-fg-tertiary hover:text-fg-secondary" : "text-fg-primary"
          }`}
        >
          {syncing ? (
            <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
          ) : (
            <Icon size={13} strokeWidth={1.75} />
          )}
          <span className="@max-[15rem]:hidden">{label}</span>
          {plan.diverged ? (
            <span className="flex items-center gap-1 text-2xs text-fg-secondary tabular-nums">
              <span>↑{plan.ahead}</span>
              <span>↓{plan.behind}</span>
            </span>
          ) : plan.ahead + plan.behind > 0 ? (
            <span className="text-2xs text-fg-secondary tabular-nums">{plan.ahead + plan.behind}</span>
          ) : null}
        </button>
      </Tooltip>
      <MenuRoot>
        <MenuTrigger>
          <button
            type="button"
            aria-label="More ways to sync"
            disabled={busy}
            className="grid h-7 w-5 place-items-center rounded-md text-fg-tertiary transition-colors outline-none hover:bg-surface-hover hover:text-fg-secondary disabled:opacity-60 data-popup-open:bg-surface-active max-md:h-10 max-md:w-8"
          >
            <ChevronDown size={12} strokeWidth={2} />
          </button>
        </MenuTrigger>
        <MenuPopup side="bottom" align="end">
          <MenuItem icon={RefreshCw} onClick={() => run("fetch")}>
            Fetch
          </MenuItem>
          <MenuItem icon={ArrowDown} disabled={!plan.can.pull} onClick={() => run("pull")}>
            Pull
          </MenuItem>
          <MenuItem icon={ArrowUp} disabled={!plan.can.push} onClick={() => run("push")}>
            Push
          </MenuItem>
          {plan.can.publish ? (
            <MenuItem icon={CloudUpload} onClick={() => run("publish")}>
              Publish branch
            </MenuItem>
          ) : null}
          {plan.can.force ? (
            <>
              <MenuSeparator />
              <MenuItem tone="danger" onClick={() => onAsk({ kind: "forcePush" })}>
                Force push…
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </MenuRoot>
    </div>
  );
}

/** The tooltip: where the branch stands, and when it was last fetched (as of the moment it opened). */
function Hint({ root, hint }: { readonly root: string; readonly hint: string }) {
  const fetched = useAtomValue(fetchedAtAtom(root));
  const [now] = useState(Date.now);
  return (
    <span className="flex flex-col">
      <span>{hint}</span>
      <span className="text-fg-tertiary">{fetchedNote(fetched, now, whenAgo)}</span>
    </span>
  );
}
