import { Combobox } from "@base-ui/react/combobox";
import type { ProjectInfo } from "@cerium/protocol";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Check, ChevronDown, FolderOpen, FolderPlus, Search, X } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { machineAtom } from "../../backend/machine.ts";
import { removeProject, savedProjectsAtom, saveProject } from "../../backend/projects.ts";
import { pickFolder } from "../../backend/shell.ts";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { ProjectBadge } from "../threads/ProjectBadge.tsx";
import { projectName, projectPlace, rankProjects } from "./projectList.ts";

/** The list's last row, which browses for a folder that isn't saved yet. */
const ADD_FOLDER = "cerium:add-folder";

interface ProjectPickerProps {
  /** The folder the next work thread starts in. */
  readonly folder: string | undefined;
  readonly onChoose: (folder: string) => void;
}

/**
 * Chooses the folder a new work thread runs in from the saved projects, most recently used first,
 * or browses for another one, which is saved for next time.
 */
export function ProjectPicker({ folder, onChoose }: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const projects = AsyncResult.getOrElse(
    useAtomValue(savedProjectsAtom),
    (): ReadonlyArray<ProjectInfo> => [],
  );
  const refresh = useAtomRefresh(savedProjectsAtom);
  const machine = useAtomValue(machineAtom);
  const save = useAtomSet(saveProject, { mode: "promise" });
  const remove = useAtomSet(removeProject, { mode: "promise" });
  const byPath = new Map(projects.map((project) => [project.path, project]));
  const paths = projects.map((project) => project.path);
  const matches = rankProjects(paths, query);

  /** Saving marks the folder as just used, so it leads the list next time. */
  const choose = (path: string) => {
    onChoose(path);
    void save({ payload: { path } }).then(refresh, () => undefined);
  };

  const browse = () => {
    void pickFolder().then((picked) => {
      if (picked !== undefined) choose(picked);
    });
  };

  const forget = (path: string) => {
    void remove({ payload: { path } }).then(refresh, () => undefined);
  };

  return (
    <Combobox.Root<string>
      items={[...paths, ADD_FOLDER]}
      filteredItems={[...matches, ADD_FOLDER]}
      inputValue={query}
      onInputValueChange={setQuery}
      value={folder ?? null}
      open={open}
      onOpenChange={(next) => {
        if (next) refresh();
        setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) setQuery("");
      }}
      onValueChange={(value) => {
        if (value === null) return;
        setOpen(false);
        if (value === ADD_FOLDER) {
          if (machine === undefined) browse();
        } else choose(value);
      }}
      autoHighlight
    >
      <Tooltip label={folder ?? "Choose the folder agents work in"}>
        <Combobox.Trigger
          aria-label="Project"
          className={`flex h-7 max-w-52 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] whitespace-nowrap transition-colors select-none hover:bg-surface-hover data-popup-open:bg-surface-active ${
            folder ? "text-fg-primary" : "text-attention"
          }`}
        >
          {folder ? (
            <ProjectBadge folder={folder} name={projectName(folder)} size="small" />
          ) : (
            <FolderOpen size={13} strokeWidth={1.75} className="shrink-0" />
          )}
          <span className="truncate font-medium">{folder ? projectName(folder) : "Choose project"}</span>
          <ChevronDown size={12} strokeWidth={2} className="shrink-0 text-fg-tertiary" />
        </Combobox.Trigger>
      </Tooltip>
      <Combobox.Portal>
        <Combobox.Positioner side="top" align="start" sideOffset={6} className="z-50 outline-none">
          <Combobox.Popup
            aria-label="Projects"
            className="w-80 origin-(--transform-origin) overflow-hidden rounded-xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0"
          >
            <label className="flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
              <Search size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
              <Combobox.Input
                placeholder="Find a project"
                className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-fg-primary outline-none placeholder:text-fg-tertiary"
              />
            </label>
            {/* Under the search field, the list grows to 22rem or the room above the box. */}
            <ScrollArea viewportClassName="max-h-[min(22rem,calc(var(--available-height)-2.5rem-2px))] scroll-py-1">
              <Combobox.List className="p-1">
                {(item: string) =>
                  item === ADD_FOLDER ? (
                    <AddFolderItem
                      key={item}
                      elsewhere={machine?.name}
                      hint={
                        projects.length === 0
                          ? "Folders you work in are saved here."
                          : matches.length === 0
                            ? "No saved project matches."
                            : undefined
                      }
                    />
                  ) : (
                    <ProjectItem
                      key={item}
                      project={byPath.get(item) ?? { path: item, usedAt: 0 }}
                      onRemove={() => forget(item)}
                    />
                  )
                }
              </Combobox.List>
            </ScrollArea>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

const itemClass =
  "group/item flex cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none select-none data-highlighted:bg-surface-hover";

function ProjectItem({ project, onRemove }: { project: ProjectInfo; onRemove: () => void }) {
  const name = projectName(project.path);
  return (
    <Combobox.Item value={project.path} disabled={project.missing === true} className={itemClass}>
      <span className={project.missing ? "opacity-40 grayscale" : undefined}>
        <ProjectBadge folder={project.path} name={name} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`truncate text-[13px] ${project.missing ? "text-fg-disabled" : "text-fg-primary"}`}>
          {name}
        </span>
        <span className="truncate text-2xs text-fg-tertiary">
          {project.missing ? "Folder not found" : projectPlace(project.path)}
        </span>
      </span>
      <Combobox.ItemIndicator className="shrink-0 text-fg-secondary group-hover/item:hidden">
        <Check size={13} strokeWidth={2.25} />
      </Combobox.ItemIndicator>
      <Tooltip label="Remove from projects">
        <button
          type="button"
          aria-label={`Remove ${name} from projects`}
          // The row itself chooses the project; the button inside it must not.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="pointer-events-auto hidden size-5 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors group-hover/item:grid hover:bg-surface-active hover:text-fg-primary"
        >
          <X size={12} strokeWidth={2} />
        </button>
      </Tooltip>
    </Combobox.Item>
  );
}

/**
 * Browses for a folder; `hint` stands in for the projects when there are none to show. Another
 * machine's folders can't be browsed from here yet, so it says where to add one instead.
 */
function AddFolderItem({ hint, elsewhere }: { hint: string | undefined; elsewhere: string | undefined }) {
  if (elsewhere !== undefined) {
    return (
      <>
        {hint ? (
          <p className="px-2 pt-2 pb-1.5 text-[12.5px] leading-relaxed text-fg-tertiary">{hint}</p>
        ) : (
          <Combobox.Separator className="mx-2 my-1 h-px bg-line-subtle" />
        )}
        <Combobox.Item value={ADD_FOLDER} disabled className={`${itemClass} data-disabled:opacity-100`}>
          <span className="grid size-4.5 shrink-0 place-items-center text-fg-tertiary">
            <FolderPlus size={14} strokeWidth={1.75} />
          </span>
          <span className="flex-1 text-[12.5px] leading-snug text-fg-tertiary">
            Add folders in Cerium on {elsewhere}
          </span>
        </Combobox.Item>
      </>
    );
  }
  return (
    <>
      {hint ? (
        <p className="px-2 pt-2 pb-1.5 text-[12.5px] leading-relaxed text-fg-tertiary">{hint}</p>
      ) : (
        <Combobox.Separator className="mx-2 my-1 h-px bg-line-subtle" />
      )}
      <Combobox.Item value={ADD_FOLDER} className={itemClass}>
        <span className="grid size-4.5 shrink-0 place-items-center text-fg-secondary">
          <FolderPlus size={14} strokeWidth={1.75} />
        </span>
        <span className="flex-1 text-[13px] text-fg-secondary group-data-highlighted/item:text-fg-primary">
          Add folder…
        </span>
      </Combobox.Item>
    </>
  );
}
