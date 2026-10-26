import { Button } from "@base-ui/react/button";
import type { ProjectInfo, SavedPrompt } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ChevronDown, ChevronUp, Pencil, Plus, X } from "lucide-react";
import { useState } from "react";

import { accountAtom } from "../../backend/atoms.ts";
import { machineAtom } from "../../backend/machine.ts";
import { savedProjectsAtom } from "../../backend/projects.ts";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { PromptDialog, type PromptDraft } from "../composer/PromptDialog.tsx";
import { newPrompt, scopeLabel, usePrompts } from "../composer/prompts.ts";
import { SettingsCard, SettingsPage, SettingsSection } from "./parts.tsx";

/** The first backend that keeps saved prompts; an older one has nowhere to save them. */
const PROMPTS_VERSION = 37;

/** The first line of a prompt's text, for its row. */
const preview = (text: string): string => text.split("\n").find((line) => line.trim() !== "") ?? "";

/** An edited prompt with the dialog's draft applied; a cleared scope leaves the prompt. */
const editedPrompt = (prompt: SavedPrompt, draft: PromptDraft): SavedPrompt => {
  const { folder: _scope, ...kept } = prompt;
  return {
    ...kept,
    name: draft.name,
    text: draft.text,
    ...(draft.folder === undefined ? {} : { folder: draft.folder }),
  };
};

/**
 * The saved prompts: what each inserts from the `/` list, where it works, and the order it lists
 * in. Saved by the backend, so they follow the user. New ones join at the end.
 */
export function PromptSettings() {
  const { prompts, disabled, error, savePrompt, removePrompt, movePrompt } = usePrompts();
  const listed = useAtomValue(savedProjectsAtom);
  const projects = AsyncResult.getOrElse(listed, (): ReadonlyArray<ProjectInfo> => [])
    .filter((project) => project.missing !== true)
    .map((project) => project.path);
  const driven = useAtomValue(machineAtom);
  const account = AsyncResult.getOrElse(useAtomValue(accountAtom), () => undefined);
  const drivenVersion =
    driven === undefined || account?._tag !== "SignedIn"
      ? undefined
      : (account.devices.find((device) => device.id === driven.id)?.rpcVersion ?? 0);
  const [editing, setEditing] = useState<{ readonly prompt: SavedPrompt } | { readonly fresh: true }>();

  if (drivenVersion !== undefined && drivenVersion < PROMPTS_VERSION) {
    return (
      <SettingsPage title="Prompts">
        <p className="rounded-xl border border-line-subtle px-4 py-3 text-body text-fg-tertiary">
          Update Cerium on that computer to use saved prompts.
        </p>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="Prompts"
      description="Type / at the start of the message box to insert one: a saved prompt's text, or an action that runs at once."
    >
      <SettingsSection
        title="Saved prompts"
        description={
          error ? (
            <span className="block text-error">{error}</span>
          ) : (
            "Everywhere prompts work in any thread; a project's only in its own."
          )
        }
        action={
          <Button
            disabled={disabled}
            onClick={() => setEditing({ fresh: true })}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary data-disabled:opacity-40"
          >
            <Plus size={13} strokeWidth={1.75} />
            New prompt
          </Button>
        }
      >
        {prompts.length === 0 ? (
          <p className="rounded-xl border border-line-subtle px-4 py-3 text-body text-fg-tertiary">
            No saved prompts yet. Keep one from a message's menu, or start one here.
          </p>
        ) : (
          <SettingsCard className="flex flex-col divide-y divide-line-subtle">
            {prompts.map((prompt, index) => (
              <PromptRow
                key={prompt.id}
                prompt={prompt}
                disabled={disabled}
                first={index === 0}
                last={index === prompts.length - 1}
                onEdit={() => setEditing({ prompt })}
                onRemove={() => removePrompt(prompt.id)}
                onMove={(toward) => movePrompt(prompt.id, toward)}
              />
            ))}
          </SettingsCard>
        )}
      </SettingsSection>
      {editing ? (
        <PromptDialog
          key={"prompt" in editing ? editing.prompt.id : "new"}
          title={"prompt" in editing ? "Edit prompt" : "New prompt"}
          submit="Save prompt"
          initial={
            "prompt" in editing
              ? {
                  name: editing.prompt.name,
                  text: editing.prompt.text,
                  ...(editing.prompt.folder ? { folder: editing.prompt.folder } : {}),
                }
              : { name: "", text: "" }
          }
          folders={projects}
          onSave={(draft) =>
            "prompt" in editing
              ? savePrompt(editedPrompt(editing.prompt, draft))
              : savePrompt(newPrompt(draft))
          }
          open
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
        />
      ) : null}
    </SettingsPage>
  );
}

/** One saved prompt: its name and scope over the start of its text, with its order and edits. */
function PromptRow({
  prompt,
  disabled,
  first,
  last,
  onEdit,
  onRemove,
  onMove,
}: {
  prompt: SavedPrompt;
  disabled: boolean;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (toward: "up" | "down") => void;
}) {
  const scope = scopeLabel(prompt);
  return (
    <div className="group/row flex min-h-12 items-center gap-1 py-2 pr-2.5 pl-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-body font-medium text-fg-primary">{prompt.name}</span>
          <span className="shrink-0 text-caption text-fg-tertiary" title={prompt.folder}>
            {scope ?? "Everywhere"}
          </span>
        </span>
        <span className="truncate text-meta leading-relaxed text-fg-tertiary">{preview(prompt.text)}</span>
      </div>
      <span className="flex shrink-0 items-center">
        <Tooltip label="Move up">
          <Button
            aria-label={`Move ${prompt.name} up`}
            disabled={disabled || first}
            onClick={() => onMove("up")}
            className="grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary focus-visible:opacity-100 data-disabled:opacity-40 pointer-coarse:opacity-100"
          >
            <ChevronUp size={14} strokeWidth={1.75} />
          </Button>
        </Tooltip>
        <Tooltip label="Move down">
          <Button
            aria-label={`Move ${prompt.name} down`}
            disabled={disabled || last}
            onClick={() => onMove("down")}
            className="grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary focus-visible:opacity-100 data-disabled:opacity-40 pointer-coarse:opacity-100"
          >
            <ChevronDown size={14} strokeWidth={1.75} />
          </Button>
        </Tooltip>
        <Tooltip label="Edit prompt">
          <Button
            aria-label={`Edit ${prompt.name}`}
            disabled={disabled}
            onClick={onEdit}
            className="grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary focus-visible:opacity-100 data-disabled:opacity-40 pointer-coarse:opacity-100"
          >
            <Pencil size={14} strokeWidth={1.75} />
          </Button>
        </Tooltip>
        <Tooltip label="Delete prompt">
          <Button
            aria-label={`Delete ${prompt.name}`}
            disabled={disabled}
            onClick={onRemove}
            className="grid size-7 place-items-center rounded-md text-fg-tertiary opacity-0 transition-[opacity,color,background-color] group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-surface-hover hover:text-fg-primary focus-visible:opacity-100 data-disabled:opacity-40 pointer-coarse:opacity-100"
          >
            <X size={14} strokeWidth={1.75} />
          </Button>
        </Tooltip>
      </span>
    </div>
  );
}
