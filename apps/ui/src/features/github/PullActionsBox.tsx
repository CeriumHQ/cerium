import { Button } from "@base-ui/react/button";
import type { GitHubRepository, MergeMethod, PullRequestDetail, ReviewEvent } from "@cerium/rpc";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Eye,
  GitMerge,
  GitPullRequestClosed,
  TriangleAlert,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { DialogButton, DialogCheck, FormDialog } from "../../components/ui/FormDialog.tsx";
import { MenuItem, MenuPopup, MenuRoot, MenuTrigger } from "../../components/ui/Menu.tsx";
import { mergeStateNote } from "./model.ts";
import { CommentBox } from "./parts.tsx";
import type { PullActions } from "./usePullRequest.ts";

/** What a comment being written holds, by pull request, while the window is open. */
export const pullDraftAtom = Atom.family((_id: string) => Atom.make("").pipe(Atom.keepAlive));

/** The way the user last merged, which the merge button offers first. */
const mergeMethodAtom = Atom.make<MergeMethod | undefined>(undefined).pipe(Atom.keepAlive);

const methodLabel: Record<MergeMethod, { button: string; menu: string; note: string }> = {
  merge: {
    button: "Merge",
    menu: "Create a merge commit",
    note: "Its commits join the base branch with a merge commit.",
  },
  squash: {
    button: "Squash and merge",
    menu: "Squash and merge",
    note: "Its commits are combined into one commit on the base branch.",
  },
  rebase: {
    button: "Rebase and merge",
    menu: "Rebase and merge",
    note: "Its commits are replayed onto the base branch, one by one.",
  },
};

const writes = (repository: GitHubRepository) =>
  repository.permission === "write" ||
  repository.permission === "maintain" ||
  repository.permission === "admin";

/**
 * Where a pull request stands on its way in: its checks, its reviews and whether it merges cleanly,
 * with the merge button (or, for a draft, the way to ready it) for those who may.
 */
export function MergeBox({
  pull,
  repository,
  actions,
  onShowChecks,
}: {
  pull: PullRequestDetail;
  repository: GitHubRepository;
  actions: PullActions;
  onShowChecks: () => void;
}) {
  const [chosen, setChosen] = useAtom(mergeMethodAtom);
  const [confirming, setConfirming] = useState(false);
  const methods = repository.mergeMethods;
  const method = chosen !== undefined && methods.includes(chosen) ? chosen : methods[0];
  const canMerge = writes(repository) && method !== undefined;
  const busy = actions.busy !== undefined;

  const checks =
    pull.checks === "failing" ? (
      <Line icon={<CircleX size={15} strokeWidth={2} className="text-error" />} onClick={onShowChecks}>
        Some checks failed
      </Line>
    ) : pull.checks === "pending" ? (
      <Line
        icon={<CircleDashed size={15} strokeWidth={2} className="text-attention" />}
        onClick={onShowChecks}
      >
        Checks are running
      </Line>
    ) : pull.checks === "passing" ? (
      <Line icon={<CircleCheck size={15} strokeWidth={2} className="text-success" />} onClick={onShowChecks}>
        All checks passed
      </Line>
    ) : null;
  const review =
    pull.reviewDecision === "approved" ? (
      <Line icon={<CircleCheck size={15} strokeWidth={2} className="text-success" />}>Approved</Line>
    ) : pull.reviewDecision === "changesRequested" ? (
      <Line icon={<CircleX size={15} strokeWidth={2} className="text-error" />}>Changes requested</Line>
    ) : pull.reviewDecision === "reviewRequired" ? (
      <Line icon={<Eye size={15} strokeWidth={2} className="text-attention" />}>Review required</Line>
    ) : null;
  const conflicts = pull.mergeable === "conflicting";
  const note = conflicts ? mergeStateNote("dirty") : mergeStateNote(pull.mergeState);
  const merging =
    pull.mergeable === "unknown" && note === undefined ? (
      <Line icon={<CircleDashed size={15} strokeWidth={2} className="text-fg-tertiary" />}>
        GitHub is checking whether it merges cleanly
      </Line>
    ) : note === undefined ? null : (
      <Line
        icon={
          conflicts || pull.mergeState === "blocked" || pull.mergeState === "behind" ? (
            <TriangleAlert size={15} strokeWidth={2} className="text-attention" />
          ) : (
            <CircleCheck size={15} strokeWidth={2} className="text-success" />
          )
        }
      >
        {note}
      </Line>
    );

  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface-raised">
      <ul className="flex flex-col divide-y divide-line-subtle">
        {checks ? <li>{checks}</li> : null}
        {review ? <li>{review}</li> : null}
        {pull.draft ? (
          <li>
            <Line icon={<CircleDot size={15} strokeWidth={2} className="text-fg-tertiary" />}>
              This is a draft, not ready for review yet
            </Line>
          </li>
        ) : merging ? (
          <li>{merging}</li>
        ) : null}
      </ul>
      {pull.draft ? (
        pull.canUpdate ? (
          <footer className="flex justify-end border-t border-line-subtle px-3.5 py-2.5">
            <DialogButton tone="primary" disabled={busy} onClick={() => void actions.setDraft(false)}>
              {actions.busy === "draft" ? "Marking ready…" : "Ready for review"}
            </DialogButton>
          </footer>
        ) : null
      ) : canMerge ? (
        <footer className="flex flex-wrap items-center gap-2 border-t border-line-subtle px-3.5 py-2.5">
          <span className="min-w-0 flex-1 text-[12px] text-fg-tertiary">{methodLabel[method].note}</span>
          <div className="flex items-center">
            <DialogButton
              tone={conflicts ? "neutral" : "primary"}
              disabled={busy || conflicts}
              onClick={() => setConfirming(true)}
              className={methods.length > 1 ? "rounded-r-none" : ""}
            >
              <span className="inline-flex items-center gap-1.5">
                <GitMerge size={13} strokeWidth={2} />
                {actions.busy === "merge" ? "Merging…" : methodLabel[method].button}
              </span>
            </DialogButton>
            {methods.length > 1 ? (
              <MenuRoot>
                <MenuTrigger>
                  <DialogButton
                    tone={conflicts ? "neutral" : "primary"}
                    disabled={busy || conflicts}
                    aria-label="Choose how to merge"
                    className="rounded-l-none border-l border-l-accent-fg/20 px-2"
                  >
                    <ChevronDown size={13} strokeWidth={2} />
                  </DialogButton>
                </MenuTrigger>
                <MenuPopup side="top">
                  {methods.map((each) => (
                    <MenuItem key={each} onClick={() => setChosen(each)}>
                      {methodLabel[each].menu}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </MenuRoot>
            ) : null}
          </div>
        </footer>
      ) : null}
      {method === undefined ? null : (
        <MergeDialog
          open={confirming}
          onOpenChange={setConfirming}
          pull={pull}
          method={method}
          deleteBranch={
            !repository.deleteBranchOnMerge && pull.headExists && pull.headRepository === undefined
          }
          actions={actions}
        />
      )}
    </section>
  );
}

/** One line of the merge box: an icon, and what it says, perhaps a link to more. */
function Line({ icon, onClick, children }: { icon: ReactNode; onClick?: () => void; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-2.5 px-3.5 py-2 text-[13px] text-fg-primary">
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {onClick ? (
        <Button
          onClick={onClick}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary"
        >
          Details
        </Button>
      ) : null}
    </div>
  );
}

/** Asks before merging, which can't be taken back, and whether the branch goes with it. */
function MergeDialog({
  open,
  onOpenChange,
  pull,
  method,
  deleteBranch,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pull: PullRequestDetail;
  method: MergeMethod;
  /** The branch can be deleted from here: it's the repository's own, and GitHub won't do it itself. */
  deleteBranch: boolean;
  actions: PullActions;
}) {
  const [remove, setRemove] = useState(true);
  const merge = async () => {
    if (await actions.merge(method, pull.headOid, deleteBranch && remove)) onOpenChange(false);
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (actions.busy !== "merge") onOpenChange(next);
      }}
      title={`${methodLabel[method].button} #${pull.number}?`}
      description={
        <>
          Into <code className="font-mono text-[12px]">{pull.base}</code> from{" "}
          <code className="font-mono text-[12px]">{pull.head}</code>. {methodLabel[method].note}
        </>
      }
      onSubmit={() => void merge()}
      actions={
        <DialogButton type="submit" tone="primary" disabled={actions.busy !== undefined}>
          {actions.busy === "merge" ? "Merging…" : methodLabel[method].button}
        </DialogButton>
      }
    >
      {deleteBranch ? (
        <DialogCheck checked={remove} onCheckedChange={setRemove}>
          Delete the branch <code className="font-mono text-[12px]">{pull.head}</code> after merging
        </DialogCheck>
      ) : null}
      {actions.error === undefined ? null : (
        <p role="alert" className="text-[12.5px] text-error">
          {actions.error}
        </p>
      )}
    </FormDialog>
  );
}

const textareaClass =
  "max-h-72 min-h-20 w-full resize-none rounded-lg border border-line-strong bg-transparent px-2.5 py-2 text-[13px] leading-relaxed text-fg-primary outline-none [field-sizing:content] placeholder:text-fg-tertiary focus-visible:border-fg-tertiary disabled:opacity-60 max-md:text-[15px]";

/**
 * The box under a pull request's conversation: comment, review the changes, and close or reopen it.
 * What is written is kept while the window is open, and goes only when the comment does.
 */
export function PullComposer({
  id,
  pull,
  repository,
  actions,
}: {
  /** The pull request's key, which its draft is kept under. */
  id: string;
  pull: PullRequestDetail;
  repository: GitHubRepository;
  actions: PullActions;
}) {
  const [draft, setDraft] = useAtom(pullDraftAtom(id));
  const [reviewing, setReviewing] = useState(false);
  const text = draft.trim();
  const busy = actions.busy !== undefined;
  const comment = async () => {
    if (text !== "" && (await actions.comment(text))) setDraft("");
  };
  const setState = async (state: "open" | "closed") => {
    if (text !== "") {
      if (!(await actions.comment(text))) return;
      setDraft("");
    }
    await actions.setState(state);
  };
  const merged = pull.state === "merged";

  return (
    <CommentBox
      value={draft}
      onChange={setDraft}
      onComment={() => void comment()}
      disabled={actions.busy === "comment"}
      error={reviewing ? undefined : actions.error}
      onDismiss={actions.dismiss}
    >
      {merged || !pull.canUpdate ? null : pull.state === "closed" ? (
        <DialogButton onClick={() => void setState("open")} disabled={busy}>
          <span className="inline-flex items-center gap-1.5">
            <CircleDot size={13} strokeWidth={1.75} />
            {text === "" ? "Reopen" : "Reopen with comment"}
          </span>
        </DialogButton>
      ) : (
        <DialogButton onClick={() => void setState("closed")} disabled={busy}>
          <span className="inline-flex items-center gap-1.5">
            <GitPullRequestClosed size={13} strokeWidth={1.75} />
            {text === "" ? "Close" : "Close with comment"}
          </span>
        </DialogButton>
      )}
      {merged ? null : (
        <DialogButton onClick={() => setReviewing(true)} disabled={busy}>
          Review changes
        </DialogButton>
      )}
      <DialogButton
        tone="primary"
        onClick={() => void comment()}
        disabled={busy || text === ""}
        title="Comment (Ctrl Enter)"
      >
        {actions.busy === "comment" ? "Commenting…" : "Comment"}
      </DialogButton>
      <ReviewDialog
        open={reviewing}
        onOpenChange={setReviewing}
        pull={pull}
        own={pull.mine || repository.viewer === pull.author?.login}
        actions={actions}
      />
    </CommentBox>
  );
}

const verdicts: ReadonlyArray<{ value: ReviewEvent; label: string; note: string }> = [
  { value: "comment", label: "Comment", note: "Feedback without approving or asking for changes." },
  { value: "approve", label: "Approve", note: "These changes can be merged." },
  { value: "requestChanges", label: "Request changes", note: "These must be addressed before merging." },
];

/** Submits a review of the whole pull request: a verdict, and what to say with it. */
function ReviewDialog({
  open,
  onOpenChange,
  pull,
  own,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pull: PullRequestDetail;
  /** The user opened it, so may only comment. */
  own: boolean;
  actions: PullActions;
}) {
  const [event, setEvent] = useState<ReviewEvent>("comment");
  const [body, setBody] = useState("");
  const needsText = event !== "approve" && body.trim() === "";
  const submit = async () => {
    if (needsText) return;
    if (await actions.review(event, body.trim())) {
      setBody("");
      setEvent("comment");
      onOpenChange(false);
    }
  };
  return (
    <FormDialog
      wide
      open={open}
      onOpenChange={(next) => {
        if (actions.busy !== "review") onOpenChange(next);
      }}
      title={`Review #${pull.number}`}
      onSubmit={() => void submit()}
      actions={
        <DialogButton type="submit" tone="primary" disabled={actions.busy !== undefined || needsText}>
          {actions.busy === "review" ? "Submitting…" : "Submit review"}
        </DialogButton>
      }
    >
      <textarea
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens to write the review
        autoFocus
        value={body}
        onChange={(change) => setBody(change.target.value)}
        onKeyDown={(key) => {
          if (key.key === "Enter" && (key.ctrlKey || key.metaKey)) {
            key.preventDefault();
            void submit();
          }
        }}
        placeholder="Leave a comment"
        aria-label="Review"
        spellCheck
        className={textareaClass}
      />
      <div role="radiogroup" aria-label="Verdict" className="flex flex-col gap-1">
        {verdicts.map((verdict) => {
          const disabled = own && verdict.value !== "comment";
          return (
            <label
              key={verdict.value}
              className={`grid grid-cols-[auto_1fr] items-baseline gap-x-2.5 rounded-lg px-2 py-1.5 text-[13px] ${disabled ? "opacity-40" : "hover:bg-surface-hover"}`}
            >
              <input
                type="radio"
                name="verdict"
                value={verdict.value}
                checked={event === verdict.value}
                disabled={disabled}
                onChange={() => setEvent(verdict.value)}
                className="translate-y-[2px] accent-(--accent)"
              />
              <span className="font-medium text-fg-primary">{verdict.label}</span>
              <span className="col-start-2 text-[12px] text-fg-tertiary">
                {disabled ? "You can't approve or ask for changes on your own pull request." : verdict.note}
              </span>
            </label>
          );
        })}
      </div>
      {actions.error === undefined ? null : (
        <p role="alert" className="text-[12.5px] text-error">
          {actions.error}
        </p>
      )}
    </FormDialog>
  );
}
