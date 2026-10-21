import { MAX_ISSUE_BODY, MAX_ISSUE_TITLE } from "@cerium/rpc";
import { RegistryContext, useAtomSet } from "@effect/atom-react";
import { useContext, useRef, useState } from "react";

import { createIssue, refreshIssueList } from "../../backend/issues.ts";
import { DialogButton, DialogField, DialogInput, FormDialog } from "../../components/ui/FormDialog.tsx";
import { LabelList } from "./LabelPicker.tsx";
import { SEARCH_LAG } from "./model.ts";

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "The issue couldn't be created.";

/**
 * The form that opens an issue on the repository: a title, a description and its labels. GitHub
 * answers with the new issue's number, which the viewer opens.
 */
export function NewIssueDialog({
  cwd,
  open,
  onOpenChange,
  onCreated,
  mayLabel,
}: {
  cwd: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (number: number, title: string) => void;
  /** The account may add labels; GitHub ignores them from anyone else. */
  mayLabel: boolean;
}) {
  const registry = useContext(RegistryContext);
  const create = useAtomSet(createIssue, { mode: "promise" });
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const reset = () => {
    setTitle("");
    setBody("");
    setLabels(new Set());
    setError(undefined);
  };

  const submit = async () => {
    if (running.current || title.trim() === "") return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const made = await create({
        payload: { cwd, title: title.trim(), body, ...(labels.size === 0 ? {} : { labels: [...labels] }) },
      });
      reset();
      onOpenChange(false);
      // GitHub's search takes a moment to list it, so the list is read again now and once more soon.
      refreshIssueList(registry, cwd);
      setTimeout(() => refreshIssueList(registry, cwd), SEARCH_LAG);
      onCreated(made.number, title.trim());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <FormDialog
      wide
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title="New issue"
      onSubmit={() => void submit()}
      actions={
        <DialogButton type="submit" tone="primary" disabled={busy || title.trim() === ""}>
          {busy ? "Creating…" : "Create issue"}
        </DialogButton>
      }
    >
      <div className="flex flex-col gap-3">
        <DialogField label="Title">
          <DialogInput
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={title}
            maxLength={MAX_ISSUE_TITLE}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs attention?"
          />
        </DialogField>
        <DialogField label="Description">
          <textarea
            value={body}
            maxLength={MAX_ISSUE_BODY}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Add the details. Markdown works."
            spellCheck
            className="max-h-64 min-h-28 w-full resize-none rounded-lg border border-line-strong bg-transparent px-2.5 py-2 text-[13px] leading-relaxed text-fg-primary outline-none [field-sizing:content] placeholder:text-fg-tertiary focus-visible:border-fg-tertiary max-md:text-[15px]"
          />
        </DialogField>
        {!mayLabel ? null : (
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-fg-secondary max-md:text-[13px]">Labels</span>
            <div className="overflow-hidden rounded-lg border border-line-strong">
              <LabelList
                cwd={cwd}
                chosen={labels}
                maxHeight="max-h-36"
                onToggle={(label, on) =>
                  setLabels((each) => {
                    const next = new Set(each);
                    if (on) next.add(label.name);
                    else next.delete(label.name);
                    return next;
                  })
                }
              />
            </div>
          </div>
        )}
        {error === undefined ? null : (
          <p role="alert" className="text-[12.5px] text-balance text-error max-md:text-[14px]">
            {error}
          </p>
        )}
      </div>
    </FormDialog>
  );
}
