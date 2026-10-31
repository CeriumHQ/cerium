import { Popover } from "@base-ui/react/popover";
import { Autocomplete } from "@base-ui/react/autocomplete";
import type { GitBranchList, LocalBranch, RemoteBranch } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Cloud,
  Ellipsis,
  GitBranch,
  GitCommitHorizontal,
  Plus,
} from "lucide-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Fragment, useState } from "react";

import { branchListAtom } from "../../../backend/branches.ts";
import { MenuItem, MenuPopup, MenuRoot, MenuSeparator, MenuTrigger } from "../../../components/ui/Menu.tsx";
import { Tooltip } from "../../../components/ui/Tooltip.tsx";
import { shortAgo } from "../../../lib/time.ts";
import type { BranchDialog } from "./BranchDialogs.tsx";
import { branchTitle, hasLocalBranch, matchBranches, switchBlocked } from "./model.ts";
import type { BranchControls } from "./useBranchControls.ts";

/** One row of the branch list: a local branch, a remote one nothing local follows, or the offer to make a new one. */
type Entry =
  | { readonly kind: "local"; readonly branch: LocalBranch }
  | { readonly kind: "remote"; readonly branch: RemoteBranch }
  | { readonly kind: "create"; readonly name: string };

/**
 * What is checked out, as a button that opens the branches: search them, switch to one (a remote
 * branch becomes a local one that follows it), make one, or reach what can be done to each.
 */
export function BranchMenu({
  root,
  controls,
  onAsk,
}: {
  readonly root: string;
  readonly controls: BranchControls;
  readonly onAsk: (dialog: BranchDialog) => void;
}) {
  const [open, setOpen] = useState(false);
  const state = controls.state;
  if (state === undefined || !state.repository) return null;
  const title = branchTitle(state);
  const Icon = title.detached ? GitCommitHorizontal : GitBranch;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip
        label={
          <span className="flex flex-col">
            <span className="font-medium break-all">{title.name}</span>
            <span className="text-fg-tertiary">
              {title.detached ? "HEAD is on a commit, not a branch." : "Switch or make a branch."}
            </span>
          </span>
        }
        side="bottom"
      >
        <Popover.Trigger
          aria-label={`Branch: ${title.name}`}
          className="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2 text-body text-fg-primary transition-colors select-none hover:bg-surface-hover data-popup-open:bg-surface-active max-md:h-10 max-md:text-[15px] @max-[15rem]:gap-1 @max-[15rem]:px-1.5"
        >
          <Icon size={14} strokeWidth={1.75} className="shrink-0 text-fg-secondary" />
          <span className={`truncate font-medium ${title.detached ? "font-mono text-meta" : ""}`}>
            {title.name}
          </span>
          {title.detached ? (
            <span className="shrink-0 text-caption text-fg-tertiary @max-[15rem]:hidden">detached</span>
          ) : null}
          <ChevronDown size={12} strokeWidth={2} className="shrink-0 text-fg-tertiary" />
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} className="z-50 outline-none">
          <Popover.Popup
            aria-label="Branches"
            className="flex max-h-(--available-height) w-80 max-w-[calc(100vw-1rem)] origin-(--transform-origin) flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0"
          >
            <BranchList
              root={root}
              controls={controls}
              onAsk={(dialog) => {
                setOpen(false);
                onAsk(dialog);
              }}
              onClose={() => setOpen(false)}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The list's rows for `query`: the matching local branches, then the remote ones, then the offer to make one. */
const entriesOf = (list: GitBranchList | undefined, query: string): ReadonlyArray<Entry> => {
  const shown = list === undefined ? { local: [], remote: [] } : matchBranches(list, query);
  const wanted = query.trim();
  const canCreate = list !== undefined && wanted !== "" && !hasLocalBranch(list, wanted);
  return [
    ...shown.local.map((branch): Entry => ({ kind: "local", branch })),
    ...shown.remote.map((branch): Entry => ({ kind: "remote", branch })),
    ...(canCreate ? [{ kind: "create", name: wanted } satisfies Entry] : []),
  ];
};

function BranchList({
  root,
  controls,
  onAsk,
  onClose,
}: {
  readonly root: string;
  readonly controls: BranchControls;
  readonly onAsk: (dialog: BranchDialog) => void;
  readonly onClose: () => void;
}) {
  const result = useAtomValue(branchListAtom(root));
  const list = Option.getOrUndefined(AsyncResult.value(result));
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const state = controls.state;

  const entries = entriesOf(list, query);
  const active = Math.min(highlight, Math.max(0, entries.length - 1));
  const highlighted = entries[active];

  /** Switches to a branch, asking first what to do with uncommitted changes. */
  const choose = (branch: string, here: boolean) => {
    if (here) {
      onClose();
      return;
    }
    if ((state?.changes ?? 0) > 0) {
      onAsk({ kind: "switch", branch });
      return;
    }
    onClose();
    void controls.switchTo(branch, "carry");
  };

  const pick = (entry: Entry) => {
    if (entry.kind === "create") onAsk({ kind: "create", name: entry.name });
    else if (entry.kind === "local") {
      if (switchBlocked(entry.branch) === undefined) choose(entry.branch.name, entry.branch.current);
    } else choose(entry.branch.name, false);
  };

  return (
    <Autocomplete.Root
      open
      inline
      items={entries}
      filter={null}
      autoHighlight="always"
      keepHighlight
      value={query}
      onValueChange={setQuery}
      itemToStringValue={(entry: Entry) => (entry.kind === "create" ? entry.name : entry.branch.name)}
      onItemHighlighted={(_entry, details) => setHighlight(details.index)}
    >
      <Autocomplete.Input
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
        }}
        placeholder="Find or make a branch"
        aria-label="Find or make a branch"
        spellCheck={false}
        autoComplete="off"
        className="h-9 shrink-0 border-b border-line-subtle bg-transparent px-3 text-body text-fg-primary outline-none placeholder:text-fg-tertiary max-md:h-12 max-md:text-[15px]"
      />
      <Autocomplete.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
        {list === undefined ? (
          <p className="px-2 py-3 text-meta text-fg-tertiary">
            {AsyncResult.isFailure(result) ? "Couldn't list the branches." : "Loading branches…"}
          </p>
        ) : entries.length === 0 ? (
          <p className="px-2 py-3 text-meta text-fg-tertiary">No branch matches.</p>
        ) : null}
        {/* The rows take the same entries and handlers on every render, so moving the highlight
            draws again only the rows it leaves and reaches. */}
        {entries.map((entry, at) => (
          <Fragment key={entry.kind === "create" ? "create" : `${entry.kind}:${entry.branch.name}`}>
            {at === 0 || entries[at - 1]!.kind !== entry.kind ? (
              <Section label={sectionLabel[entry.kind]} />
            ) : null}
            <Row entry={entry} highlighted={at === active} onPick={pick} />
          </Fragment>
        ))}
        {list?.truncated === true ? (
          <p className="px-2 py-2 text-meta text-fg-tertiary">
            More branches exist than are listed. Search to find them.
          </p>
        ) : null}
      </Autocomplete.List>
      {highlighted !== undefined && highlighted.kind !== "create" ? (
        <div className="flex h-9 shrink-0 items-center gap-2 border-t border-line-subtle px-3 text-body text-fg-secondary">
          <span className="min-w-0 flex-1 truncate">Actions for {highlighted.branch.name}</span>
          <RowActions entry={highlighted} here={controls.state?.branch} controls={controls} onAsk={onAsk} />
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => onAsk({ kind: "create" })}
        className="flex h-9 shrink-0 items-center gap-2 border-t border-line-subtle px-3 text-body text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary max-md:h-12 max-md:text-[15px]"
      >
        <Plus size={14} strokeWidth={1.75} />
        New branch…
      </button>
    </Autocomplete.Root>
  );
}

const sectionLabel: Readonly<Record<Entry["kind"], string>> = {
  local: "Local",
  remote: "Remote",
  create: "New",
};

function Section({ label }: { readonly label: string }) {
  return <p className="px-2 pt-2 pb-1 text-caption font-medium text-fg-tertiary select-none">{label}</p>;
}

function Row({
  entry,
  highlighted,
  onPick,
}: {
  readonly entry: Entry;
  readonly highlighted: boolean;
  readonly onPick: (entry: Entry) => void;
}) {
  const blocked = entry.kind === "local" ? switchBlocked(entry.branch) : undefined;
  const name = entry.kind === "create" ? entry.name : entry.branch.name;
  const mainClass = `flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body outline-none max-md:py-2.5 max-md:text-[15px] ${
    blocked === undefined ? "text-fg-secondary" : "text-fg-tertiary"
  }`;
  const main = (
    <Autocomplete.Item
      value={entry}
      // Not `disabled`, which would keep the tooltip that says why from opening.
      aria-disabled={blocked !== undefined}
      onClick={blocked === undefined ? () => onPick(entry) : undefined}
      className={mainClass}
    >
      {entry.kind === "create" ? (
        <>
          <Plus size={14} strokeWidth={1.75} className="shrink-0" />
          <span className="truncate">
            Make branch <span className="font-medium text-fg-primary">{name}</span>
          </span>
        </>
      ) : (
        <>
          {entry.kind === "local" && entry.branch.current ? (
            <Check size={14} strokeWidth={2} className="shrink-0 text-fg-primary" />
          ) : entry.kind === "remote" ? (
            <Cloud size={14} strokeWidth={1.75} className="shrink-0" />
          ) : (
            <GitBranch size={14} strokeWidth={1.75} className="shrink-0" />
          )}
          <span
            className={`truncate ${entry.kind === "local" && entry.branch.current ? "font-medium text-fg-primary" : highlighted ? "text-fg-primary" : ""}`}
          >
            {name}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2 text-caption text-fg-tertiary tabular-nums">
            {blocked !== undefined ? (
              <span>In another worktree</span>
            ) : entry.kind === "local" ? (
              <Distance branch={entry.branch} />
            ) : null}
            {blocked === undefined ? <span>{shortAgo(entry.branch.committedAt * 1000)}</span> : null}
          </span>
        </>
      )}
    </Autocomplete.Item>
  );
  return (
    <div
      data-highlighted={highlighted ? "" : undefined}
      className="group flex items-center rounded-lg data-highlighted:bg-surface-hover"
    >
      {blocked === undefined ? (
        main
      ) : (
        <Tooltip label={blocked} side="left">
          {main}
        </Tooltip>
      )}
    </div>
  );
}

function Distance({ branch }: { readonly branch: LocalBranch }) {
  const upstream = branch.upstream;
  if (upstream === undefined || upstream.gone) return null;
  if (upstream.ahead === 0 && upstream.behind === 0) return null;
  return (
    <span className="flex items-center gap-1.5">
      {upstream.ahead > 0 ? (
        <span className="flex items-center">
          <ArrowUp size={10} strokeWidth={2} />
          {upstream.ahead}
        </span>
      ) : null}
      {upstream.behind > 0 ? (
        <span className="flex items-center">
          <ArrowDown size={10} strokeWidth={2} />
          {upstream.behind}
        </span>
      ) : null}
    </span>
  );
}

/** What can be done to a branch besides switching to it. */
function RowActions({
  entry,
  here,
  controls,
  onAsk,
}: {
  readonly entry: Exclude<Entry, { readonly kind: "create" }>;
  readonly here: string | undefined;
  readonly controls: BranchControls;
  readonly onAsk: (dialog: BranchDialog) => void;
}) {
  const branch = entry.branch.name;
  const current = entry.kind === "local" && entry.branch.current;
  const mergeable = here !== undefined && !current && controls.state?.operation === undefined;
  const remove = async () => {
    const result = await controls.deleteBranch(branch, false);
    if (result?.unmerged !== undefined) onAsk({ kind: "delete", branch, commits: result.unmerged });
  };
  return (
    <MenuRoot>
      <MenuTrigger>
        <button
          type="button"
          aria-label={`Actions for ${branch}`}
          className="mr-1 grid size-6 shrink-0 place-items-center rounded-md text-fg-tertiary outline-none hover:bg-surface-active hover:text-fg-primary focus-visible:bg-surface-active data-popup-open:bg-surface-active max-md:size-9"
        >
          <Ellipsis size={14} strokeWidth={1.75} />
        </button>
      </MenuTrigger>
      <MenuPopup side="bottom" align="end">
        {mergeable ? (
          <MenuItem onClick={() => onAsk({ kind: "merge", branch })}>Merge into {here}…</MenuItem>
        ) : null}
        {entry.kind === "local" ? (
          <>
            {mergeable ? <MenuSeparator /> : null}
            <MenuItem onClick={() => onAsk({ kind: "rename", branch })}>Rename…</MenuItem>
            <MenuItem onClick={() => onAsk({ kind: "upstream", branch })}>Set upstream…</MenuItem>
            {current ? null : (
              <>
                <MenuSeparator />
                <MenuItem tone="danger" onClick={() => void remove()}>
                  Delete
                </MenuItem>
              </>
            )}
          </>
        ) : mergeable ? null : (
          <MenuItem disabled>Nothing to do here</MenuItem>
        )}
      </MenuPopup>
    </MenuRoot>
  );
}
