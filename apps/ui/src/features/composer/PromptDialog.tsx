import { MAX_PROMPT_NAME } from "@cerium/protocol";
import { useState } from "react";

import {
  DialogButton,
  DialogField,
  DialogInput,
  DialogSelect,
  FormDialog,
} from "../../components/ui/FormDialog.tsx";

// The name, text and scope of one saved prompt, for the settings page and the message menu's
// "Save as prompt". Keyed by the prompt it edits, so its fields start over for another one.

export interface PromptDraft {
  readonly name: string;
  readonly text: string;
  readonly folder?: string | undefined;
}

const textClass =
  "min-h-28 w-full rounded-lg border border-line-strong bg-transparent px-2.5 py-2 text-body text-fg-primary outline-none placeholder:text-fg-tertiary focus-visible:border-fg-tertiary max-md:text-[15px]";

export function PromptDialog({
  title,
  submit,
  initial,
  folders,
  onSave,
  open,
  onOpenChange,
}: {
  readonly title: string;
  readonly submit: string;
  readonly initial: PromptDraft;
  /** The projects offered besides Everywhere, with the prompt's own first when it names another. */
  readonly folders: ReadonlyArray<string>;
  readonly onSave: (draft: PromptDraft) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [text, setText] = useState(initial.text);
  const [scope, setScope] = useState(initial.folder ?? "everywhere");
  const options =
    initial.folder !== undefined && !folders.includes(initial.folder)
      ? [initial.folder, ...folders]
      : folders;
  const saveable = name.trim() !== "" && text.trim() !== "";
  const save = () => {
    if (!saveable) return;
    onSave({ name: name.trim(), text, ...(scope === "everywhere" ? {} : { folder: scope }) });
    onOpenChange(false);
  };
  return (
    <FormDialog
      wide
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description="Type / at the start of the message box to insert it."
      onSubmit={save}
      actions={
        <DialogButton tone="primary" type="submit" disabled={!saveable}>
          {submit}
        </DialogButton>
      }
    >
      <DialogField label="Name">
        <DialogInput
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={MAX_PROMPT_NAME}
          placeholder="Summarise the changes"
          aria-label="Prompt name"
        />
      </DialogField>
      <DialogField label="Text">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={6}
          spellCheck={false}
          placeholder="What the message box inserts"
          aria-label="Prompt text"
          className={textClass}
        />
      </DialogField>
      {options.length > 0 ? (
        <DialogField label="Works in">
          <DialogSelect
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            aria-label="Where the prompt works"
          >
            <option value="everywhere">Everywhere</option>
            {options.map((folder) => (
              <option key={folder} value={folder}>
                {folder}
              </option>
            ))}
          </DialogSelect>
        </DialogField>
      ) : null}
    </FormDialog>
  );
}
