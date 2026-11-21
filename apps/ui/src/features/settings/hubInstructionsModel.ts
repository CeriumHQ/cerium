import {
  HUB_CANONICAL_INSTRUCTIONS,
  hubInstructionStatus,
  type HubInstructionFile,
  type HubInstructionMode,
} from "@cerium/protocol";
import type { HubInstructionSync } from "@cerium/rpc";

export const canBeCanonical = (file: HubInstructionFile) =>
  !file.supplemental && file.problem === undefined && file.reference === undefined;

export const defaultInstructionSource = (files: ReadonlyArray<HubInstructionFile>) => {
  const choices = files.filter(canBeCanonical);
  const standard = choices.find((file) => file.path === HUB_CANONICAL_INSTRUCTIONS);
  return standard?.content !== undefined
    ? standard
    : (choices.find((file) => file.content !== undefined) ?? standard);
};

export interface InstructionDraft {
  readonly path: string;
  readonly revision: string;
  readonly content: string;
}

export interface InstructionSelection {
  readonly revision: string;
  readonly sourceRevision: string;
  readonly sourcePath: string;
  readonly replace: boolean;
}

export const instructionTarget = (
  file: HubInstructionFile,
  canonical: HubInstructionFile | undefined,
  selection: InstructionSelection | undefined,
) => {
  const status = hubInstructionStatus(file, canonical);
  const selectable =
    canonical !== undefined &&
    canBeCanonical(canonical) &&
    file.path !== canonical.path &&
    !file.supplemental &&
    file.sourceOnly !== true &&
    (file.problem === undefined || file.reference !== undefined);
  const stale =
    selection !== undefined &&
    (!selectable ||
      selection.revision !== file.revision ||
      selection.sourceRevision !== canonical?.revision ||
      selection.sourcePath !== canonical?.path);
  const selected = selection !== undefined && !stale;
  return { status, selectable, stale, selected, confirm: selected && status === "diverged" };
};

export const isStaleInstructionDraft = (
  draft: InstructionDraft | undefined,
  canonical: HubInstructionFile | undefined,
) => draft !== undefined && (draft.path !== canonical?.path || draft.revision !== canonical?.revision);

export const instructionSync = (
  project: string,
  files: ReadonlyArray<HubInstructionFile>,
  canonical: HubInstructionFile | undefined,
  draft: InstructionDraft | undefined,
  selections: ReadonlyMap<string, InstructionSelection>,
  mode: HubInstructionMode,
): HubInstructionSync | undefined => {
  if (canonical === undefined || !canBeCanonical(canonical)) return undefined;
  if (isStaleInstructionDraft(draft, canonical)) return undefined;
  const targets = [];
  for (const [path, selection] of selections) {
    const file = files.find((entry) => entry.path === path);
    if (file === undefined) return undefined;
    const target = instructionTarget(file, canonical, selection);
    if (!target.selected || (target.confirm && !selection.replace)) return undefined;
    targets.push({ path, revision: selection.revision, ...(target.confirm ? { replace: true } : {}) });
  }
  const content = draft?.content ?? canonical.content ?? "";
  const changed = content !== canonical.content;
  if (!changed && targets.length === 0) return undefined;
  return {
    project,
    source: { path: canonical.path, revision: canonical.revision, ...(changed ? { content } : {}) },
    targets,
    mode,
  };
};
