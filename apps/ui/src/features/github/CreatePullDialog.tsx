import type { ThreadId } from "@cerium/protocol";
import type { BranchPullRequest, GitHubRepository } from "@cerium/rpc";
import { RegistryContext, useAtomSet } from "@effect/atom-react";
import { useContext, useRef, useState } from "react";

import { createPull, draftPull, refreshPullList } from "../../backend/github.ts";
import {
  DialogButton,
  DialogCheck,
  DialogField,
  DialogInput,
  FormDialog,
} from "../../components/ui/FormDialog.tsx";
import { GenerateButton } from "../../components/ui/GenerateButton.tsx";
import { MessageBoxContext, type MessageBox } from "../composer/messageBox.ts";
import { ReviewButton } from "../review/ReviewButton.tsx";
import { ReviewCard } from "../review/ReviewCard.tsx";
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
  review,
}: {
  cwd: string;
  repository: GitHubRepository;
  branch: BranchPullRequest;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (number: number, title: string) => void;
  /**
   * The thread whose agents made the branch's commits, which a review before opening reports to, and
   * its message box, which takes the findings sent to them; none where the machine can't review.
   */
  review?: { readonly threadId: ThreadId; readonly messageBox: MessageBox | undefined } | undefined;
}) {
  const [reviewError, setReviewError] = useState<string>();
  const registry = useContext(RegistryContext);
  const create = useAtomSet(createPull, { mode: "promise" });
  const name = branch.branch ?? "";
  const [title, setTitle] = useState(() => titleOfBranch(name));
  const [body, setBody] = useState(branch.template ?? "");
  const [base, setBase] = useState(repository.defaultBranch);
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const draftWith = useAtomSet(draftPull, { mode: "promise" });
  /** A quick model is writing the title and description; the fields wait for it. */
  const [writing, setWriting] = useState(false);
  const running = useRef(false);

  // The model reads the title and description so far, the template included, and fills them in.
  const write = async () => {
    if (base.trim() === "") return;
    setWriting(true);
    setError(undefined);
    try {
      const written = await draftWith({ payload: { cwd, base: base.trim(), title, body } });
      setTitle(written.title);
      setBody(written.body);
    } catch (cause) {
      setError(messageOf(cause));
    }
    // Not a `finally`: the React Compiler skips a component that has one. The catch takes every
    // failure, so this runs either way.
    setWriting(false);
  };

  const submit = async () => {
    if (running.current || writing || title.trim() === "" || base.trim() === "") return;
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
    }
    running.current = false;
    setBusy(false);
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
          From <code className="font-mono text-meta">{name}</code>
          {branch.pushed ? "" : ", which is pushed to GitHub first"}.
        </>
      }
      onSubmit={() => void submit()}
      aside={
        <div className="-ml-2.5 flex items-center gap-1">
          <GenerateButton
            label="Write the title and description from the branch's commits"
            busy={writing}
            disabled={busy || base.trim() === ""}
            onClick={() => void write()}
          >
            Generate
          </GenerateButton>
          {review === undefined || base.trim() === "" ? null : (
            <ReviewButton
              threadId={review.threadId}
              target={{ _tag: "Branch", cwd, base: base.trim() }}
              disabled={busy}
              onError={setReviewError}
            />
          )}
        </div>
      }
      actions={
        <DialogButton
          type="submit"
          tone="primary"
          disabled={busy || writing || title.trim() === "" || base.trim() === ""}
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
            readOnly={writing}
            spellCheck
          />
        </DialogField>
        <DialogField label="Description">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            readOnly={writing}
            spellCheck
            placeholder={writing ? "Writing from the branch's commits…" : "What it changes, and why"}
            className="max-h-72 min-h-28 w-full resize-none rounded-lg border border-line-strong bg-transparent px-2.5 py-2 text-body leading-relaxed text-fg-primary outline-none [field-sizing:content] placeholder:text-fg-tertiary focus-visible:border-fg-tertiary max-md:text-[15px]"
          />
        </DialogField>
        <DialogField label="Into">
          <DialogInput value={base} onChange={(event) => setBase(event.target.value)} />
        </DialogField>
        <DialogCheck checked={draft} onCheckedChange={setDraft}>
          Open it as a draft
        </DialogCheck>
        {error === undefined ? null : (
          <p role="alert" className="text-meta text-error">
            {error}
          </p>
        )}
        {reviewError === undefined ? null : (
          <p role="alert" className="text-meta text-error">
            {reviewError}
          </p>
        )}
        {review === undefined || base.trim() === "" ? null : (
          <MessageBoxContext value={review.messageBox}>
            {/* Kept short, so its findings never push the dialog's buttons out of sight. */}
            <div className="scroll-thin max-h-40 overflow-y-auto rounded-lg">
              <ReviewCard threadId={review.threadId} target={{ _tag: "Branch", cwd, base: base.trim() }} />
            </div>
          </MessageBoxContext>
        )}
      </div>
    </FormDialog>
  );
}
