import type { BranchPullRequest, GitHubRepository } from "@cerium/rpc";
import { RegistryContext, useAtomSet } from "@effect/atom-react";
import { useContext, useRef, useState } from "react";

import { createPull, refreshPullList } from "../../backend/github.ts";
import {
  DialogButton,
  DialogCheck,
  DialogField,
  DialogInput,
  FormDialog,
} from "../../components/ui/FormDialog.tsx";
import { titleOfBranch } from "./model.ts";

/** GitHub's search takes a few seconds to list a new pull request; the list is read once more after it. */
const SEARCH_LAG = 4_000;

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "GitHub couldn't open the pull request.";

/**
 * Opens a pull request from the branch checked out in the folder, into the repository's default
 * branch unless another is named; a branch not on GitHub yet is pushed first.
 */
export function CreatePullDialog({
  cwd,
  repository,
  branch,
  open,
  onOpenChange,
  onCreated,
}: {
  cwd: string;
  repository: GitHubRepository;
  branch: BranchPullRequest;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (number: number, title: string) => void;
}) {
  const registry = useContext(RegistryContext);
  const create = useAtomSet(createPull, { mode: "promise" });
  const name = branch.branch ?? "";
  const [title, setTitle] = useState(() => titleOfBranch(name));
  const [body, setBody] = useState(branch.template ?? "");
  const [base, setBase] = useState(repository.defaultBranch);
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const submit = async () => {
    if (running.current || title.trim() === "" || base.trim() === "") return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const made = await create({ payload: { cwd, title: title.trim(), body, base: base.trim(), draft } });
      onOpenChange(false);
      refreshPullList(registry, cwd);
      setTimeout(() => refreshPullList(registry, cwd), SEARCH_LAG);
      onCreated(made.number, made.title);
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
      title="Open a pull request"
      description={
        <>
          From <code className="font-mono text-[12px]">{name}</code>
          {branch.pushed ? "" : ", which is pushed to GitHub first"}.
        </>
      }
      onSubmit={() => void submit()}
      actions={
        <DialogButton
          type="submit"
          tone="primary"
          disabled={busy || title.trim() === "" || base.trim() === ""}
        >
          {busy ? (branch.pushed ? "Opening…" : "Pushing…") : draft ? "Open as draft" : "Open pull request"}
        </DialogButton>
      }
    >
      <div className="flex flex-col gap-3">
        <DialogField label="Title">
          <DialogInput
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens to name the pull request
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            spellCheck
          />
        </DialogField>
        <DialogField label="Description">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            spellCheck
            placeholder="What it changes, and why"
            className="max-h-72 min-h-28 w-full resize-none rounded-lg border border-line-strong bg-transparent px-2.5 py-2 text-[13px] leading-relaxed text-fg-primary outline-none [field-sizing:content] placeholder:text-fg-tertiary focus-visible:border-fg-tertiary max-md:text-[15px]"
          />
        </DialogField>
        <DialogField label="Into">
          <DialogInput value={base} onChange={(event) => setBase(event.target.value)} />
        </DialogField>
        <DialogCheck checked={draft} onCheckedChange={setDraft}>
          Open it as a draft
        </DialogCheck>
        {error === undefined ? null : (
          <p role="alert" className="text-[12.5px] text-error">
            {error}
          </p>
        )}
      </div>
    </FormDialog>
  );
}
