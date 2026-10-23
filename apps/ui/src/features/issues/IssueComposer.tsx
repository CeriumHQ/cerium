import type { CloseReason, IssueDetail } from "@cerium/rpc";
import { useAtom } from "@effect/atom-react";
import { ChevronDown, CircleCheck, CircleDot, CircleSlash, Lock } from "lucide-react";

import { issueDraftAtom } from "../../backend/issues.ts";
import { DialogButton } from "../../components/ui/FormDialog.tsx";
import { MenuItem, MenuPopup, MenuRoot, MenuTrigger } from "../../components/ui/Menu.tsx";
import { keyLabel } from "../../lib/keys.ts";
import { CommentBox } from "../github/parts.tsx";
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
    <CommentBox
      value={draft}
      onChange={setDraft}
      onComment={() => void comment()}
      placeholder={issue.locked ? "Leave a comment (the conversation is locked)" : "Leave a comment"}
      disabled={actions.busy === "comment"}
      error={actions.error}
      onDismiss={actions.dismiss}
    >
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
        title={`Comment (${keyLabel("Ctrl Enter")})`}
      >
        {actions.busy === "comment" ? "Commenting…" : "Comment"}
      </DialogButton>
    </CommentBox>
  );
}
