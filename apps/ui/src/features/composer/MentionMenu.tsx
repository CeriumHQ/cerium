import type {
  Mention,
  ModelInfo,
  ProjectInfo,
  ProviderId,
  SkillInfo,
  WorkspaceEntry,
} from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { FolderGit2, LoaderCircle } from "lucide-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { settingsAtom } from "../../backend/atoms.ts";
import { skillsAtom, skillsKey, workspaceSearchAtom, workspaceSearchKey } from "../../backend/files.ts";
import { savedProjectsAtom } from "../../backend/projects.ts";
import { FileIcon } from "../../components/FileIcon.tsx";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { providerName } from "../threads/model.ts";
import type { Trigger } from "./draft.ts";
import { useModels } from "./models.ts";

export interface MentionOption {
  readonly key: string;
  readonly group: "files" | "projects" | "models" | "skills";
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
  /** A chat, which tags saved projects and models with `@` instead of a single folder's files. */
  readonly chat: boolean;
}

const noEntries = Atom.make(AsyncResult.success<ReadonlyArray<WorkspaceEntry>>([]));
const noSkills = Atom.make(AsyncResult.success<ReadonlyArray<SkillInfo>>([]));

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const withoutSeparators = (value: string) => value.replace(/[\s._-]+/g, "");

/** Rank literal matches first, then retry with common separators stripped from both sides. */
const mentionRanker = (wanted: string) => {
  const compact = withoutSeparators(wanted);
  return (names: ReadonlyArray<string>, details: ReadonlyArray<string> = []): number | undefined => {
    const rank = (query: string, normalize: (value: string) => string) => {
      const normalizedNames = names.map(normalize);
      if (normalizedNames.some((name) => name.startsWith(query))) return 0;
      if (normalizedNames.some((name) => name.includes(query))) return 1;
      if (details.some((detail) => normalize(detail).includes(query))) return 2;
      return undefined;
    };
    const literal = rank(wanted, (value) => value.toLowerCase());
    if (literal !== undefined || compact === "") return literal;
    const loose = rank(compact, (value) => withoutSeparators(value.toLowerCase()));
    return loose === undefined ? undefined : loose + 3;
  };
};

const fileOption = (entry: WorkspaceEntry): MentionOption => ({
  key: `${entry.folder ? "d" : "f"}:${entry.path}`,
  group: "files",
  mention: { _tag: "FileMention", path: entry.path, folder: entry.folder },
  label: nameOf(entry.path),
  ...(parentOf(entry.path) === "" ? {} : { detail: parentOf(entry.path) }),
});

/** Saved projects matching `query` by folder name first, then full path. */
export const projectOptions = (
  projects: ReadonlyArray<ProjectInfo>,
  query: string,
): ReadonlyArray<MentionOption> => {
  const rankMatch = mentionRanker(query.trim().toLowerCase());
  return projects
    .filter((project) => project.missing !== true)
    .flatMap((project) => {
      const name = nameOf(project.path);
      const rank = rankMatch([name], [project.path]);
      return rank === undefined ? [] : [{ project, name, rank }];
    })
    .toSorted((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .map(({ project, name }) => ({
      key: `p:${project.path}`,
      group: "projects",
      mention: { _tag: "ProjectMention", name, path: project.path },
      label: name,
      detail: project.path,
    }));
};

/** Models matching `query` by model id, display label, or harness name (roster models ranked first). */
export const modelOptions = (
  models: ReadonlyArray<ModelInfo>,
  rosterKeys: ReadonlySet<string>,
  query: string,
): ReadonlyArray<MentionOption> => {
  const wanted = query.trim().toLowerCase();
  const rankMatch = mentionRanker(wanted);
  return models
    .flatMap((model) => {
      const onRoster = rosterKeys.has(`${model.provider}:${model.id}`);
      const rank =
        wanted === ""
          ? onRoster
            ? 0
            : 1
          : rankMatch([model.id, model.label], [providerName[model.provider], model.provider]);
      return rank === undefined ? [] : [{ model, onRoster, rank }];
    })
    .toSorted(
      (a, b) =>
        a.rank - b.rank ||
        Number(b.onRoster) - Number(a.onRoster) ||
        a.model.label.localeCompare(b.model.label),
    )
    .slice(0, wanted === "" ? 12 : 24)
    .map(({ model }) => ({
      key: `m:${model.provider}:${model.id}`,
      group: "models",
      mention: {
        _tag: "ModelMention",
        provider: model.provider,
        model: model.id,
        label: model.label,
      },
      label: model.label,
      detail: `${model.id} · ${providerName[model.provider]}`,
    }));
};

const skillOptions = (skills: ReadonlyArray<SkillInfo>, query: string): ReadonlyArray<MentionOption> => {
  const rankMatch = mentionRanker(query.toLowerCase());
  return skills
    .flatMap((skill) => {
      const rank = rankMatch([skill.name]);
      return rank === undefined ? [] : [{ skill, rank }];
    })
    .toSorted((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name))
    .map(({ skill }) => ({
      key: `s:${skill.name}`,
      group: "skills",
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
  const searchingFiles = trigger?.char === "@" && !sources.chat && sources.folder !== undefined;
  const listingSkills = trigger?.char === "$" && sources.provider !== undefined;
  const files = useAtomValue(
    searchingFiles ? workspaceSearchAtom(workspaceSearchKey(sources.folder!, trigger.query)) : noEntries,
  );
  const skills = useAtomValue(
    listingSkills ? skillsAtom(skillsKey(sources.provider!, sources.folder)) : noSkills,
  );
  const savedProjects = AsyncResult.getOrElse(useAtomValue(savedProjectsAtom), () => []);
  const models = useModels();
  const settings = useAtomValue(settingsAtom);
  const rosterKeys = new Set<string>();
  if (AsyncResult.isSuccess(settings)) {
    for (const entry of settings.value.roster.models) {
      rosterKeys.add(`${entry.provider}:${entry.model}`);
    }
  }
  // Tagged with the trigger it answered, so `$` never flashes the items a past `@` found.
  const [kept, setKept] = useState<{
    readonly char: Trigger["char"];
    readonly options: ReadonlyArray<MentionOption>;
  }>();

  if (trigger === undefined) {
    if (kept !== undefined) setKept(undefined);
    return { state: "ready", options: [] };
  }

  if (trigger.char === "$") {
    if (!listingSkills) return { state: "unavailable", options: [] };
    const result = AsyncResult.map(skills, (list) => skillOptions(list, trigger.query));
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

  // `@` mentions:
  // - In Chat: saved projects + models
  // - In Work: workspace files & folders + models
  const matchedModels = modelOptions(models, rosterKeys, trigger.query);

  if (sources.chat) {
    const matchedProjects = projectOptions(savedProjects, trigger.query);
    const options = [...matchedProjects, ...matchedModels];
    return { state: "ready", options };
  }

  if (!searchingFiles) {
    return matchedModels.length > 0
      ? { state: "ready", options: matchedModels }
      : { state: "unavailable", options: [] };
  }

  const fileResult = AsyncResult.map(files, (entries) => entries.map(fileOption));
  if (AsyncResult.isFailure(fileResult)) {
    return matchedModels.length > 0
      ? { state: "ready", options: matchedModels }
      : { state: "failed", options: [] };
  }
  if (!AsyncResult.isSuccess(fileResult)) {
    const previousFiles = kept?.char === "@" ? kept.options.filter((each) => each.group === "files") : [];
    return { state: "loading", options: [...previousFiles, ...matchedModels] };
  }
  const options = [...fileResult.value, ...matchedModels];
  if (
    kept?.char !== "@" ||
    options.length !== kept.options.length ||
    options.some((option, index) => option.key !== kept.options[index]?.key)
  ) {
    setKept({ char: "@", options });
  }
  return { state: "ready", options };
}

const groupHeading = (group: MentionOption["group"], harness: string): string => {
  switch (group) {
    case "files":
      return "Files and folders";
    case "projects":
      return "Projects";
    case "models":
      return "Models";
    case "skills":
      return `${harness} skills`;
  }
};

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

  const at = trigger.char === "@";
  const harness = sources.provider ? providerName[sources.provider] : "This harness";
  const empty =
    results.state === "unavailable"
      ? at
        ? "Choose a folder first to tag its files."
        : "Pick a model to see its skills."
      : results.state === "failed"
        ? at
          ? "Couldn't search this folder."
          : `${harness} couldn't list its skills.`
        : results.state === "loading"
          ? undefined
          : at
            ? trigger.query === ""
              ? sources.chat
                ? "No saved projects or models available."
                : "This folder is empty."
              : `Nothing matches “${trigger.query}”.`
            : trigger.query === ""
              ? `${harness} didn't report any skills.`
              : `No skill matches “${trigger.query}”.`;

  const groups: Array<{
    readonly group: MentionOption["group"];
    readonly items: Array<{ option: MentionOption; index: number }>;
  }> = [];
  results.options.forEach((option, index) => {
    const last = groups.at(-1);
    if (last?.group === option.group) last.items.push({ option, index });
    else groups.push({ group: option.group, items: [{ option, index }] });
  });

  return (
    <>
      {groups.length === 0 ? (
        <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-caption font-medium text-fg-tertiary">
          {at ? (sources.chat ? "Projects and models" : "Files and models") : `${harness} skills`}
          {results.state === "loading" ? <LoaderCircle size={11} className="animate-spin" /> : null}
        </div>
      ) : null}
      {/* The editor keeps focus and points into this list, which a <select> can't be. */}
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role */}
      <div ref={list} id="mention-menu" role="listbox" className="max-h-64 overflow-y-auto px-1 pb-1">
        {groups.map(({ group, items }, groupIndex) => (
          <div key={group}>
            <div
              className={`flex items-center gap-1.5 px-2 pb-1 text-caption font-medium text-fg-tertiary ${
                groupIndex === 0 ? "pt-2" : "pt-2.5"
              }`}
            >
              {groupHeading(group, harness)}
              {groupIndex === 0 && results.state === "loading" ? (
                <LoaderCircle size={11} className="animate-spin" />
              ) : null}
            </div>
            {items.map(({ option, index }) => (
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
                ) : option.mention._tag === "ProjectMention" ? (
                  <FolderGit2 size={14} strokeWidth={1.75} className="shrink-0 text-fg-secondary" />
                ) : option.mention._tag === "ModelMention" ? (
                  <ProviderLogo provider={option.mention.provider} size={14} />
                ) : (
                  <FileIcon skill className="size-4" />
                )}
                <span className="shrink-0 font-medium text-fg-primary">{option.label}</span>
                {option.detail ? (
                  <span className="min-w-0 truncate text-meta text-fg-tertiary">{option.detail}</span>
                ) : null}
              </div>
            ))}
          </div>
        ))}
        {results.options.length === 0 && empty ? (
          <p className="px-2 py-1.5 text-meta text-fg-tertiary">{empty}</p>
        ) : null}
      </div>
    </>
  );
}
