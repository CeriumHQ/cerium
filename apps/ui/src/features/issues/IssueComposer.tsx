import type { CloseReason, IssueDetail } from "@cerium/rpc";
import { useAtom } from "@effect/atom-react";
import { ChevronDown, CircleCheck, CircleDot, CircleSlash, Lock, X } from "lucide-react";

import { issueDraftAtom } from "../../backend/issues.ts";
import { DialogButton } from "../../components/ui/FormDialog.tsx";
import { MenuItem, MenuPopup, MenuRoot, MenuTrigger } from "../../components/ui/Menu.tsx";
import type { IssueActions } from "./useIssueActions.ts";

/**
 * The box under an issue's conversation: write a comment, and close the issue with or without it, or
 * reopen it. What is written is kept while the window is open, and goes only when the comment does.
 */
export function IssueComposer({
  id,
  issue,
  triage,
  actions,
}: {
  /** The issue's key (see `issueKey`), which its draft is kept under. */
  id: string;
  issue: IssueDetail;
  /** The account may triage, which lets it comment on a locked conversation. */
  triage: boolean;
  actions: IssueActions;
}) {
  const [draft, setDraft] = useAtom(issueDraftAtom(id));
  const text = draft.trim();
  const busy = actions.busy !== undefined;
  const closed = issue.state === "closed";

  if (issue.locked && !triage) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-line-subtle px-3 py-2.5 text-[13px] text-fg-tertiary max-md:text-[14px]">
        <Lock size={13} strokeWidth={1.75} className="shrink-0" />
        This conversation is locked. Only collaborators can comment.
      </p>
    );
  }

  const comment = async () => {
    if (text === "") return;
    if (await actions.comment(text)) setDraft("");
  };
  const close = async (reason: CloseReason) => {
    if (await actions.close(reason, text)) setDraft("");
  };
  const reopen = async () => {
    if (text !== "") {
      if (!(await actions.comment(text))) return;
      setDraft("");
    }
    await actions.reopen();
  };

  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void comment();
          }
        }}
        placeholder={issue.locked ? "Leave a comment (the conversation is locked)" : "Leave a comment"}
        aria-label="Comment"
        spellCheck
        disabled={actions.busy === "comment"}
        className="max-h-72 min-h-20 w-full resize-none rounded-lg border border-line-strong bg-transparent px-2.5 py-2 text-[13px] leading-relaxed text-fg-primary outline-none [field-sizing:content] placeholder:text-fg-tertiary focus-visible:border-fg-tertiary disabled:opacity-60 max-md:text-[15px]"
      />
      {actions.error === undefined ? null : (
        <p role="alert" className="flex items-start gap-2 text-[12.5px] text-error max-md:text-[14px]">
          <span className="min-w-0 flex-1 text-balance">{actions.error}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={actions.dismiss}
            className="grid size-4 shrink-0 place-items-center rounded text-error/70 hover:text-error"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!issue.canUpdate ? null : closed ? (
          <DialogButton onClick={() => void reopen()} disabled={busy}>
            <span className="inline-flex items-center gap-1.5">
              <CircleDot size={13} strokeWidth={1.75} />
              {text === "" ? "Reopen issue" : "Reopen with comment"}
            </span>
          </DialogButton>
        ) : (
          <MenuRoot>
            <MenuTrigger>
              <DialogButton disabled={busy} aria-label="Close issue">
                <span className="inline-flex items-center gap-1.5">
                  {text === "" ? "Close issue" : "Close with comment"}
                  <ChevronDown size={13} strokeWidth={1.75} />
                </span>
              </DialogButton>
            </MenuTrigger>
            <MenuPopup side="top">
              <MenuItem icon={CircleCheck} onClick={() => void close("completed")}>
                Close as completed
              </MenuItem>
              <MenuItem icon={CircleSlash} onClick={() => void close("notPlanned")}>
                Close as not planned
              </MenuItem>
            </MenuPopup>
          </MenuRoot>
        )}
        <DialogButton
          tone="primary"
          onClick={() => void comment()}
          disabled={busy || text === ""}
          title="Comment (Ctrl Enter)"
        >
          {actions.busy === "comment" ? "Commenting…" : "Comment"}
        </DialogButton>
      </div>
    </div>
  );
}
