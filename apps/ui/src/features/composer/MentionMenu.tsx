import type { Mention, ProviderId, SkillInfo, WorkspaceEntry } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { LoaderCircle } from "lucide-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { skillsAtom, skillsKey, workspaceSearchAtom, workspaceSearchKey } from "../../backend/files.ts";
import { FileIcon } from "../../components/FileIcon.tsx";
import { providerName } from "../threads/model.ts";
import type { Trigger } from "./draft.ts";

export interface MentionOption {
  readonly key: string;
  readonly mention: Mention;
  readonly label: string;
  readonly detail?: string;
}

export interface MentionOptions {
  readonly state: "loading" | "ready" | "failed" | "unavailable";
  readonly options: ReadonlyArray<MentionOption>;
}

/** Where `@` and `$` look: the thread's folder, and the lead's harness. */
export interface MentionSources {
  readonly folder: string | undefined;
  readonly provider: ProviderId | undefined;
  /** A chat, which has no folder at all, rather than a work thread whose folder isn't chosen yet. */
  readonly chat: boolean;
}

const noEntries = Atom.make(AsyncResult.success<ReadonlyArray<WorkspaceEntry>>([]));
const noSkills = Atom.make(AsyncResult.success<ReadonlyArray<SkillInfo>>([]));

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const fileOption = (entry: WorkspaceEntry): MentionOption => ({
  key: `${entry.folder ? "d" : "f"}:${entry.path}`,
  mention: { _tag: "FileMention", path: entry.path, folder: entry.folder },
  label: nameOf(entry.path),
  ...(parentOf(entry.path) === "" ? {} : { detail: parentOf(entry.path) }),
});

/** Skills whose name starts with the query first, then those containing it. */
const skillOptions = (skills: ReadonlyArray<SkillInfo>, query: string): ReadonlyArray<MentionOption> => {
  const wanted = query.toLowerCase();
  return skills
    .flatMap((skill) => {
      const name = skill.name.toLowerCase();
      const rank = name.startsWith(wanted) ? 0 : name.includes(wanted) ? 1 : undefined;
      return rank === undefined ? [] : [{ skill, rank }];
    })
    .toSorted((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name))
    .map(({ skill }) => ({
      key: `s:${skill.name}`,
      mention: { _tag: "SkillMention", name: skill.name, ...(skill.path ? { path: skill.path } : {}) },
      label: skill.name,
      ...(skill.description ? { detail: skill.description } : {}),
    }));
};

/**
 * What the tag being typed could be. While a new query loads, the previous matches stay up, so the
 * list narrows as the user types instead of flashing.
 */
export function useMentionOptions(trigger: Trigger | undefined, sources: MentionSources): MentionOptions {
  const searching = trigger?.char === "@" && sources.folder !== undefined;
  const listingSkills = trigger?.char === "$" && sources.provider !== undefined;
  const files = useAtomValue(
    searching ? workspaceSearchAtom(workspaceSearchKey(sources.folder!, trigger.query)) : noEntries,
  );
  const skills = useAtomValue(
    listingSkills ? skillsAtom(skillsKey(sources.provider!, sources.folder)) : noSkills,
  );
  // Tagged with the trigger it answered, so `$` never flashes the files a past `@` found.
  const [kept, setKept] = useState<{
    readonly char: Trigger["char"];
    readonly options: ReadonlyArray<MentionOption>;
  }>();

  if (trigger === undefined) {
    if (kept !== undefined) setKept(undefined);
    return { state: "ready", options: [] };
  }
  if (trigger.char === "@" && !searching) return { state: "unavailable", options: [] };
  if (trigger.char === "$" && !listingSkills) return { state: "unavailable", options: [] };

  const result =
    trigger.char === "@"
      ? AsyncResult.map(files, (entries) => entries.map(fileOption))
      : AsyncResult.map(skills, (list) => skillOptions(list, trigger.query));
  if (AsyncResult.isFailure(result)) return { state: "failed", options: [] };
  if (!AsyncResult.isSuccess(result)) {
    return { state: "loading", options: kept?.char === trigger.char ? kept.options : [] };
  }
  const options = result.value;
  if (
    kept?.char !== trigger.char ||
    options.length !== kept.options.length ||
    options.some((option, index) => option.key !== kept.options[index]?.key)
  ) {
    setKept({ char: trigger.char, options });
  }
  return { state: "ready", options };
}

/** The list above the message box while a tag is being typed. Keyboard focus stays in the editor. */
export function MentionMenu({
  trigger,
  sources,
  results,
  active,
  onActive,
  onPick,
}: {
  trigger: Trigger;
  sources: MentionSources;
  results: MentionOptions;
  active: number;
  onActive: (index: number) => void;
  onPick: (mention: Mention) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const files = trigger.char === "@";
  const harness = sources.provider ? providerName[sources.provider] : "This harness";
  const empty =
    results.state === "unavailable"
      ? files
        ? sources.chat
          ? "Chats have no folder to tag files from."
          : "Choose a folder first to tag its files."
        : "Pick a model to see its skills."
      : results.state === "failed"
        ? files
          ? "Couldn't search this folder."
          : `${harness} couldn't list its skills.`
        : results.state === "loading"
          ? undefined
          : files
            ? trigger.query === ""
              ? "This folder is empty."
              : `Nothing matches “${trigger.query}”.`
            : trigger.query === ""
              ? `${harness} didn't report any skills.`
              : `No skill matches “${trigger.query}”.`;

  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-full z-10 mb-2 overflow-hidden rounded-xl border border-line-subtle bg-surface-overlay shadow-overlay backdrop-blur-2xl">
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-caption font-medium text-fg-tertiary">
        {files ? "Files and folders" : `${harness} skills`}
        {results.state === "loading" ? <LoaderCircle size={11} className="animate-spin" /> : null}
      </div>
      {/* The editor keeps focus and points into this list, which a <select> can't be. */}
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role */}
      <div ref={list} id="mention-menu" role="listbox" className="max-h-64 overflow-y-auto px-1 pb-1">
        {results.options.map((option, index) => (
          <div
            key={option.key}
            id={`mention-option-${index}`}
            data-index={index}
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="option"
            tabIndex={-1}
            aria-selected={index === active}
            // Keeps focus, and the caret, in the editor.
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(option.mention);
            }}
            onMouseMove={() => onActive(index)}
            className={`flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-body ${
              index === active ? "bg-surface-active text-fg-primary" : "text-fg-secondary"
            }`}
          >
            {option.mention._tag === "FileMention" ? (
              <FileIcon path={option.mention.path} folder={option.mention.folder} className="size-4" />
            ) : (
              <FileIcon skill className="size-4" />
            )}
            <span className="shrink-0 font-medium text-fg-primary">{option.label}</span>
            {option.detail ? (
              <span className="min-w-0 truncate text-meta text-fg-tertiary">{option.detail}</span>
            ) : null}
          </div>
        ))}
        {results.options.length === 0 && empty ? (
          <p className="px-2 py-1.5 text-meta text-fg-tertiary">{empty}</p>
        ) : null}
      </div>
    </div>
  );
}
