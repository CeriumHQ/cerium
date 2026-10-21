import type { SwitchChanges } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { branchListAtom } from "../../../backend/branches.ts";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog.tsx";
import {
  DialogButton,
  DialogCheck,
  DialogField,
  DialogInput,
  DialogSelect,
  FormDialog,
} from "../../../components/ui/FormDialog.tsx";
import { branchNameProblem, hasLocalBranch, operationName } from "./model.ts";
import type { BranchControls } from "./useBranchControls.ts";

/** A question the branch controls ask before they change the repository. */
export type BranchDialog =
  /** Switching with changes that aren't committed: what happens to them. */
  | { readonly kind: "switch"; readonly branch: string }
  | { readonly kind: "create"; readonly name?: string }
  | { readonly kind: "rename"; readonly branch: string }
  | { readonly kind: "upstream"; readonly branch: string }
  /** Git refused to delete a branch with commits on no other branch. */
  | { readonly kind: "delete"; readonly branch: string; readonly commits: number }
  | { readonly kind: "merge"; readonly branch: string }
  | { readonly kind: "forcePush" }
  | { readonly kind: "abort" }
  | { readonly kind: "stash" }
  | { readonly kind: "drop"; readonly commit: string; readonly message: string };

interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly root: string;
  readonly controls: BranchControls;
}

/**
 * Shows the question `dialog` names, over whatever the panel shows. The form is made afresh each time a
 * question is asked, and stays through the dialog's closing so it fades rather than empties.
 */
export function BranchDialogs({
  root,
  controls,
  dialog,
  onClose,
}: {
  readonly root: string;
  readonly controls: BranchControls;
  readonly dialog: BranchDialog | undefined;
  readonly onClose: () => void;
}) {
  const [shown, setShown] = useState<{ readonly dialog: BranchDialog; readonly id: number } | undefined>(
    undefined,
  );
  if (dialog !== undefined && dialog !== shown?.dialog) setShown({ dialog, id: (shown?.id ?? 0) + 1 });
  if (shown === undefined) return null;
  const props = { open: dialog !== undefined, onClose, root, controls };
  const asked = shown.dialog;
  switch (asked.kind) {
    case "switch":
      return <SwitchDialog key={shown.id} {...props} branch={asked.branch} />;
    case "create":
      return <CreateDialog key={shown.id} {...props} name={asked.name ?? ""} />;
    case "rename":
      return <RenameDialog key={shown.id} {...props} branch={asked.branch} />;
    case "upstream":
      return <UpstreamDialog key={shown.id} {...props} branch={asked.branch} />;
    case "delete":
      return <DeleteDialog key={shown.id} {...props} branch={asked.branch} commits={asked.commits} />;
    case "merge":
      return <MergeDialog key={shown.id} {...props} branch={asked.branch} />;
    case "forcePush":
      return <ForcePushDialog key={shown.id} {...props} />;
    case "abort":
      return <AbortDialog key={shown.id} {...props} />;
    case "stash":
      return <StashDialog key={shown.id} {...props} />;
    case "drop":
      return <DropDialog key={shown.id} {...props} commit={asked.commit} message={asked.message} />;
  }
}

function SwitchDialog({ open, onClose, controls, branch }: DialogProps & { readonly branch: string }) {
  const go = (changes: SwitchChanges) => {
    onClose();
    void controls.switchTo(branch, changes);
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => next || onClose()}
      title={`Switch to ${branch}`}
      description="You have changes that aren't committed. Take them to the other branch, or stash them to get them back later."
      actions={
        <>
          <DialogButton onClick={() => go("stash")}>Stash changes</DialogButton>
          <DialogButton tone="primary" onClick={() => go("carry")}>
            Bring them along
          </DialogButton>
        </>
      }
    />
  );
}

function CreateDialog({
  open,
  onClose,
  root,
  controls,
  name: initial,
}: DialogProps & { readonly name: string }) {
  const list = Option.getOrUndefined(AsyncResult.value(useAtomValue(branchListAtom(root))));
  const [name, setName] = useState(initial);
  const [from, setFrom] = useState("");
  const [switchTo, setSwitchTo] = useState(true);
  const [changes, setChanges] = useState<SwitchChanges>("carry");
  const dirty = (controls.state?.changes ?? 0) > 0;
  const wanted = name.trim();
  const problem =
    wanted === ""
      ? undefined
      : (branchNameProblem(wanted) ??
        (list !== undefined && hasLocalBranch(list, wanted) ? "A branch by that name exists." : undefined));
  const ready = wanted !== "" && problem === undefined;
  const create = () => {
    if (!ready) return;
    onClose();
    void controls.createBranch(wanted, {
      switch: switchTo,
      changes,
      ...(from === "" ? {} : { from }),
    });
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => next || onClose()}
      title="New branch"
      onSubmit={create}
      actions={
        <DialogButton type="submit" tone="primary" disabled={!ready}>
          Create
        </DialogButton>
      }
    >
      <div className="flex flex-col gap-3">
        <DialogField label="Name">
          <DialogInput
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="feature/something"
          />
          {problem === undefined ? null : <span className="text-[12px] text-error">{problem}</span>}
        </DialogField>
        <DialogField label="Start from">
          <DialogSelect value={from} onChange={(event) => setFrom(event.currentTarget.value)}>
            <option value="">The current commit</option>
            {list === undefined ? null : (
              <>
                <optgroup label="Local">
                  {list.local.map((branch) => (
                    <option key={branch.name} value={branch.name}>
                      {branch.name}
                    </option>
                  ))}
                </optgroup>
                {list.remote.length === 0 ? null : (
                  <optgroup label="Remote">
                    {list.remote.map((branch) => (
                      <option key={branch.name} value={branch.name}>
                        {branch.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </>
            )}
          </DialogSelect>
        </DialogField>
        <DialogCheck checked={switchTo} onCheckedChange={setSwitchTo}>
          Switch to it
        </DialogCheck>
        {dirty && switchTo && from !== "" ? (
          <DialogField label="Your uncommitted changes">
            <DialogSelect
              value={changes}
              onChange={(event) => setChanges(event.currentTarget.value === "stash" ? "stash" : "carry")}
            >
              <option value="carry">Come along</option>
              <option value="stash">Go to the stash</option>
            </DialogSelect>
          </DialogField>
        ) : null}
      </div>
    </FormDialog>
  );
}

function RenameDialog({ open, onClose, controls, branch }: DialogProps & { readonly branch: string }) {
  const [name, setName] = useState(branch);
  const wanted = name.trim();
  const problem = wanted === branch || wanted === "" ? undefined : branchNameProblem(wanted);
  const ready = wanted !== "" && wanted !== branch && problem === undefined;
  const rename = () => {
    if (!ready) return;
    onClose();
    void controls.renameBranch(branch, wanted);
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => next || onClose()}
      title={`Rename ${branch}`}
      description="Only the local branch changes. A remote branch of the old name stays as it is."
      onSubmit={rename}
      actions={
        <DialogButton type="submit" tone="primary" disabled={!ready}>
          Rename
        </DialogButton>
      }
    >
      <DialogField label="New name">
        <DialogInput value={name} onChange={(event) => setName(event.currentTarget.value)} />
        {problem === undefined ? null : <span className="text-[12px] text-error">{problem}</span>}
      </DialogField>
    </FormDialog>
  );
}

function UpstreamDialog({
  open,
  onClose,
  root,
  controls,
  branch,
}: DialogProps & { readonly branch: string }) {
  const list = Option.getOrUndefined(AsyncResult.value(useAtomValue(branchListAtom(root))));
  const current = list?.local.find((one) => one.name === branch)?.upstream?.name ?? "";
  const [upstream, setUpstream] = useState<string | undefined>(undefined);
  const chosen = upstream ?? current;
  const save = () => {
    onClose();
    void controls.setUpstream(branch, chosen === "" ? undefined : chosen);
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => next || onClose()}
      title={`What ${branch} follows`}
      description="Pull and Push use this remote branch."
      onSubmit={save}
      actions={
        <DialogButton type="submit" tone="primary" disabled={chosen === current}>
          Save
        </DialogButton>
      }
    >
      <DialogField label="Remote branch">
        <DialogSelect value={chosen} onChange={(event) => setUpstream(event.currentTarget.value)}>
          <option value="">None</option>
          {(list?.remote ?? []).map((one) => (
            <option key={one.name} value={one.name}>
              {one.name}
            </option>
          ))}
        </DialogSelect>
      </DialogField>
    </FormDialog>
  );
}

function DeleteDialog({
  open,
  onClose,
  controls,
  branch,
  commits,
}: DialogProps & { readonly branch: string; readonly commits: number }) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => next || onClose()}
      title={`Delete ${branch}?`}
      description={`${commits === 1 ? "1 commit" : `${commits} commits`} on it ${commits === 1 ? "isn't" : "aren't"} on any other branch. They are hard to get back once it is gone.`}
      confirmLabel="Delete"
      onConfirm={() => void controls.deleteBranch(branch, true)}
    />
  );
}

function MergeDialog({ open, onClose, controls, branch }: DialogProps & { readonly branch: string }) {
  const into = controls.state?.branch ?? "the current commit";
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => next || onClose()}
      title={`Merge ${branch}`}
      description={`Brings what ${branch} has into ${into}. If both changed the same lines, you settle them under Changes.`}
      actions={
        <DialogButton
          tone="primary"
          onClick={() => {
            onClose();
            void controls.merge(branch);
          }}
        >
          Merge
        </DialogButton>
      }
    />
  );
}

function ForcePushDialog({ open, onClose, controls }: DialogProps) {
  const upstream = controls.state?.upstream?.name ?? "the remote branch";
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => next || onClose()}
      title="Force push?"
      description={`${upstream} is overwritten with your branch, so commits only it has are lost for everyone else. Git still refuses if it changed since you last fetched.`}
      confirmLabel="Force push"
      onConfirm={() => void controls.push("forceWithLease")}
    />
  );
}

function AbortDialog({ open, onClose, controls }: DialogProps) {
  const kind = controls.state?.operation?.kind;
  const name = kind === undefined ? "operation" : operationName(kind).toLowerCase();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => next || onClose()}
      title={`Abort the ${name}?`}
      description="The branch goes back to how it was before it started, and what you settled so far is lost."
      confirmLabel="Abort"
      onConfirm={() => void controls.operation("abort")}
    />
  );
}

function StashDialog({ open, onClose, controls }: DialogProps) {
  const [message, setMessage] = useState("");
  const [untracked, setUntracked] = useState(false);
  const save = () => {
    onClose();
    void controls.stash(message, untracked);
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => next || onClose()}
      title="Stash changes"
      description="Puts your uncommitted changes aside and leaves the files as they were at the last commit."
      onSubmit={save}
      actions={
        <DialogButton type="submit" tone="primary">
          Stash
        </DialogButton>
      }
    >
      <div className="flex flex-col gap-3">
        <DialogField label="Message">
          <DialogInput
            value={message}
            onChange={(event) => setMessage(event.currentTarget.value)}
            placeholder="Optional"
          />
        </DialogField>
        <DialogCheck checked={untracked} onCheckedChange={setUntracked}>
          Include new files
        </DialogCheck>
      </div>
    </FormDialog>
  );
}

function DropDialog({
  open,
  onClose,
  controls,
  commit,
  message,
}: DialogProps & { readonly commit: string; readonly message: string }) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => next || onClose()}
      title="Drop this stash?"
      description={`“${message}” is gone for good, with the changes in it.`}
      confirmLabel="Drop"
      onConfirm={() => void controls.dropStash(commit)}
    />
  );
}
