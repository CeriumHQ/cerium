import type { FileDiff, GitFileChange, GitSide } from "@cerium/rpc";
import { Button } from "@base-ui/react/button";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Minus, Plus, Undo2, X, type LucideIcon } from "lucide-react";
import { useContext, useEffect, useEffectEvent, useState } from "react";

import { watchAtom } from "../../backend/explorer.ts";
import {
  applyLines,
  discardFiles,
  gitDiffAtom,
  gitDiffKey,
  gitStatusAtom,
  refreshGitDiffs,
  refreshGitStatus,
  stageFiles,
  unstageFiles,
} from "../../backend/git.ts";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { DiffView, type DiffLayout } from "../viewer/DiffView.tsx";
import { diffStats } from "../viewer/model.ts";
import { Note } from "../viewer/previews.tsx";
import {
  discardWords,
  hunkLines,
  lineId,
  linesBetween,
  pickedHunks,
  sameDiff,
  unstagePaths,
  type DiscardWords,
} from "./model.ts";

const sideLabel: Readonly<Record<GitSide, string>> = { unstaged: "Unstaged", staged: "Staged" };

const noPicks: ReadonlySet<string> = new Set();

const toggleClass =
  "rounded-md px-2 py-0.5 text-[12.5px] font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:px-2.5 max-md:py-1.5 max-md:text-[14px]";

const reasonOf = (error: unknown, fallback: string) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : fallback;

/** A small button acting on the file, a hunk or the picked lines. */
function ActionButton({
  icon: Icon,
  label,
  tip,
  onClick,
  quiet = false,
}: {
  icon: LucideIcon;
  label: string;
  tip?: string;
  onClick: () => void;
  /** Only its icon shows, its label in the tooltip. */
  quiet?: boolean;
}) {
  const button = (
    <Button
      aria-label={quiet ? label : undefined}
      onClick={onClick}
      className={`flex h-6 shrink-0 items-center gap-1 rounded-md text-[12px] font-medium text-fg-secondary transition-colors duration-150 hover:bg-surface-active hover:text-fg-primary max-md:h-9 max-md:text-[14px] ${quiet ? "w-6 justify-center" : "px-1.5"}`}
    >
      <Icon size={13} strokeWidth={2} className="shrink-0" />
      {quiet ? null : label}
    </Button>
  );
  return quiet || tip !== undefined ? <Tooltip label={tip ?? label}>{button}</Tooltip> : button;
}

/**
 * One side of a file's changes, as Source control opened it: what isn't staged, or what is. A whole
 * file stages, unstages or discards from the bar above it; in a changed file, so does each hunk from
 * the bar over it, and any lines picked from the boxes beside them (Shift picks a run).
 */
export function SideDiff({
  root,
  path,
  side,
  onSide,
  layout,
  context,
  whole,
  onWhole,
}: {
  /** The repository's top. */
  root: string;
  /** The file, from the top. */
  path: string;
  /** The side Source control opened; the other is shown while this one has nothing. */
  side: GitSide;
  onSide: (side: GitSide) => void;
  layout: DiffLayout;
  /** Unchanged lines asked for around each change. */
  context: number;
  whole: boolean;
  onWhole: () => void;
}) {
  const registry = useContext(RegistryContext);
  const status = Option.getOrUndefined(AsyncResult.value(useAtomValue(gitStatusAtom(root))));
  const onSides: Readonly<Record<GitSide, GitFileChange | undefined>> = {
    staged: status?.staged.find((change) => change.path === path),
    unstaged: status?.unstaged.find((change) => change.path === path),
  };
  const sides = (["unstaged", "staged"] as const).filter((each) => onSides[each] !== undefined);
  const shown: GitSide = sides.includes(side) ? side : (sides[0] ?? side);
  const change = onSides[shown];

  const result = useAtomValue(
    gitDiffAtom(
      gitDiffKey({ root, path, side: shown, from: shown === "staged" ? change?.from : undefined, context }),
    ),
  );
  const read = Option.getOrUndefined(AsyncResult.value(result));
  // Any change in the repository reads the diff again. One that says the same as the diff shown
  // leaves that one shown, so its picks hold and its lines aren't drawn again. It's set while
  // rendering, as React allows for the component's own state.
  const [held, setHeld] = useState(read);
  const diff = read !== undefined && held !== undefined && sameDiff(read, held) ? held : read;
  if (diff !== held) setHeld(diff);
  const failed = AsyncResult.isFailure(result)
    ? reasonOf(Cause.squash(result.cause), "Git couldn't compare that file.")
    : undefined;

  // The machine says when the file or git's view of it changes; the diff is read again then.
  const onBatch = useEffectEvent(
    (batch: { paths: ReadonlyArray<string>; status: boolean; overflow?: boolean }) => {
      if (batch.status || batch.overflow === true) refreshGitStatus(registry, root);
      else if (batch.paths.includes(path)) refreshGitDiffs(registry, root);
    },
  );
  useEffect(
    () =>
      registry.subscribe(
        watchAtom(root),
        (batch) => {
          if (AsyncResult.isSuccess(batch)) onBatch(batch.value);
        },
        { immediate: true },
      ),
    [registry, root],
  );

  const stage = useAtomSet(stageFiles, { mode: "promise" });
  const unstage = useAtomSet(unstageFiles, { mode: "promise" });
  const discard = useAtomSet(discardFiles, { mode: "promise" });
  const apply = useAtomSet(applyLines, { mode: "promise" });
  const [failure, setFailure] = useState<string>();
  const [asking, setAsking] = useState<{
    readonly words: DiscardWords;
    readonly run: () => void;
    readonly open: boolean;
  }>();

  // Picks belong to the diff they were made on, on its side: one that reads the same is the same.
  const [picks, setPicks] = useState<{
    readonly diff: FileDiff;
    readonly side: GitSide;
    readonly ids: ReadonlySet<string>;
    readonly anchor?: string;
  }>();
  const current = picks !== undefined && picks.diff === diff && picks.side === shown ? picks : undefined;
  const picked = current === undefined ? noPicks : current.ids;
  const hunks = diff?.hunks ?? [];

  const act = async (work: () => Promise<unknown>, fallback: string) => {
    setFailure(undefined);
    try {
      await work();
      setPicks(undefined);
    } catch (error) {
      setFailure(reasonOf(error, fallback));
    }
    // Not a `finally`: the React Compiler skips a component that has one. The catch takes every
    // failure, so this runs either way.
    refreshGitStatus(registry, root);
  };
  const ask = (words: DiscardWords, run: () => void) => setAsking({ words, run, open: true });

  /** Lines can be picked in a text file git compares line by line, changed rather than new, gone or moved. */
  const pickable =
    diff !== undefined && diff.binary !== true && diff.truncated !== true && change?.state === "modified";

  const applyPicked = (action: "stage" | "unstage" | "discard", ids: ReadonlySet<string>) =>
    act(
      () => apply({ payload: { root, path, action, context, hunks: pickedHunks(hunks, ids) } }),
      `Git couldn't ${action} those lines.`,
    );

  const linesWord = (count: number) => (count === 1 ? "1 line" : `${count} lines`);

  const fileActions =
    change === undefined ? null : shown === "staged" ? (
      <ActionButton
        icon={Minus}
        label="Unstage file"
        onClick={() =>
          void act(
            () => unstage({ payload: { root, paths: unstagePaths([change]) } }),
            "Git couldn't unstage that.",
          )
        }
      />
    ) : (
      <>
        <ActionButton
          icon={Undo2}
          label={change.state === "untracked" ? "Delete file" : "Discard file"}
          quiet
          onClick={() =>
            ask(
              discardWords([change], undefined),
              () =>
                void act(() => discard({ payload: { root, paths: [path] } }), "Git couldn't discard that."),
            )
          }
        />
        <ActionButton
          icon={Plus}
          label="Stage file"
          onClick={() =>
            void act(() => stage({ payload: { root, paths: [path] } }), "Git couldn't stage that.")
          }
        />
      </>
    );

  const pickActions =
    picked.size === 0 ? null : (
      <>
        <span className="mr-1 text-[12px] text-fg-tertiary tabular-nums">
          {linesWord(picked.size)} picked
        </span>
        <IconButton icon={X} label="Unpick" onClick={() => setPicks(undefined)} className="size-6" />
        {shown === "staged" ? (
          <ActionButton
            icon={Minus}
            label="Unstage lines"
            onClick={() => void applyPicked("unstage", picked)}
          />
        ) : (
          <>
            <ActionButton
              icon={Undo2}
              label="Discard lines"
              quiet
              onClick={() => {
                const ids = picked;
                ask(
                  {
                    title: `Discard ${linesWord(ids.size)}?`,
                    description: "They go back to what's staged, for good.",
                    confirm: "Discard",
                  },
                  () => void applyPicked("discard", ids),
                );
              }}
            />
            <ActionButton icon={Plus} label="Stage lines" onClick={() => void applyPicked("stage", picked)} />
          </>
        )}
      </>
    );

  const hunkActions = (hunk: number) => {
    // A file of one change acts on it from the bar above the file.
    if (hunks.length < 2) return null;
    const ids = new Set(hunkLines(hunks, hunk));
    return shown === "staged" ? (
      <ActionButton
        icon={Minus}
        label="Unstage"
        tip="Unstage this change"
        onClick={() => void applyPicked("unstage", ids)}
      />
    ) : (
      <>
        <ActionButton
          icon={Undo2}
          label="Discard this change"
          quiet
          onClick={() =>
            ask(
              {
                title: "Discard this change?",
                description: "Its lines go back to what's staged, for good.",
                confirm: "Discard",
              },
              () => void applyPicked("discard", ids),
            )
          }
        />
        <ActionButton
          icon={Plus}
          label="Stage"
          tip="Stage this change"
          onClick={() => void applyPicked("stage", ids)}
        />
      </>
    );
  };

  const onPick = (hunk: number, line: number, extend: boolean) => {
    if (diff === undefined) return;
    const id = lineId(hunk, line);
    const next = new Set(picked);
    const anchor = current === undefined ? undefined : current.anchor;
    if (extend && anchor !== undefined) {
      for (const each of linesBetween(hunks, anchor, id)) next.add(each);
    } else if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicks({ diff, side: shown, ids: next, anchor: id });
  };

  const stats = diff === undefined ? undefined : diffStats(diff.hunks);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line-subtle pr-1.5 pl-2 max-md:h-11">
        {sides.length > 1 ? (
          <ToggleGroup
            value={[shown]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "staged" || next === "unstaged") onSide(next);
            }}
            aria-label="Side"
            className="flex items-center"
          >
            {sides.map((each) => (
              <Toggle key={each} value={each} className={toggleClass}>
                {sideLabel[each]}
              </Toggle>
            ))}
          </ToggleGroup>
        ) : (
          <span className="px-1 text-[12.5px] font-medium text-fg-secondary">{sideLabel[shown]}</span>
        )}
        {stats ? (
          <span className="ml-1 shrink-0 font-mono text-[11.5px] tabular-nums">
            <span className="text-success">+{stats.added}</span>{" "}
            <span className="text-error">−{stats.removed}</span>
          </span>
        ) : null}
        <div className="ml-auto flex min-w-0 items-center gap-0.5">{pickActions ?? fileActions}</div>
      </div>
      {failure === undefined ? null : (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-1 border-b border-line-subtle bg-error/10 py-1 pr-1.5 pl-3"
        >
          <p className="min-w-0 flex-1 py-0.5 text-[12.5px] text-error">{failure}</p>
          <IconButton icon={X} label="Dismiss" onClick={() => setFailure(undefined)} className="size-6" />
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Body
          diff={diff}
          failure={failed}
          path={path}
          layout={layout}
          whole={whole}
          onWhole={onWhole}
          picking={
            pickable
              ? { picked: (hunk, line) => picked.has(lineId(hunk, line)), onPick, hunkActions }
              : undefined
          }
          staged={shown === "staged"}
        />
      </div>
      <ConfirmDialog
        open={asking?.open === true}
        onOpenChange={(next) => {
          if (!next && asking !== undefined) setAsking({ ...asking, open: false });
        }}
        title={asking?.words.title ?? ""}
        description={asking?.words.description ?? ""}
        confirmLabel={asking?.words.confirm ?? "Discard"}
        onConfirm={() => {
          if (asking?.open === true) asking.run();
        }}
      />
    </div>
  );
}

function Body({
  diff,
  failure,
  path,
  layout,
  whole,
  onWhole,
  picking,
  staged,
}: {
  diff: FileDiff | undefined;
  failure: string | undefined;
  path: string;
  layout: DiffLayout;
  whole: boolean;
  onWhole: () => void;
  picking: Parameters<typeof DiffView>[0]["picking"];
  staged: boolean;
}) {
  if (diff === undefined) return failure === undefined ? null : <Note>{failure}</Note>;
  if (diff.binary === true) return <Note>The contents changed, and they aren't text.</Note>;
  if (diff.hunks.length === 0)
    return <Note>{staged ? "Nothing of it is staged." : "Nothing of it is left to stage."}</Note>;
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <DiffView
          hunks={diff.hunks}
          path={path}
          layout={layout}
          onExpand={whole ? undefined : onWhole}
          picking={picking}
        />
      </div>
      {diff.truncated === true ? (
        <p className="shrink-0 border-t border-line-subtle px-4 py-1.5 text-xs text-fg-tertiary">
          A long diff, cut short. Stage it whole.
        </p>
      ) : null}
    </div>
  );
}
