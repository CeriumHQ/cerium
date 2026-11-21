import type { HubSkill } from "@cerium/protocol";
import { useAtomSet } from "@effect/atom-react";
import { useId } from "react";

import { setHubSkill } from "../../backend/hub.ts";
import { harnessName } from "./Harnesses.tsx";
import { AddTo } from "./HubAddTo.tsx";
import type { HubEntry, HubGroup } from "./hubModel.ts";
import {
  Copies,
  CopyLine,
  CopySwitch,
  GroupRow,
  inProject,
  Part,
  Presence,
  useSaving,
  type HubContext,
  type Mark,
} from "./hubRows.tsx";

// Settings → Skills' rows: a skill's description and each harness's copy with its switch.

export function SkillGroupRow({ group, context }: { group: HubGroup<HubSkill>; context: HubContext }) {
  const quick = group.entries.filter((entry) => entry.harness.provider === context.picked);
  const description = group.entries.find((entry) => entry.item.description)?.item.description;
  const marks = group.entries.map((entry): Mark => ({
    provider: entry.harness.provider,
    on: entry.item.enabled,
    dot: undefined,
    label: `${harnessName[entry.harness.provider]}: ${entry.item.enabled ? "On" : "Off"}`,
  }));
  return (
    <GroupRow
      name={group.name}
      line={description}
      off={group.entries.every((entry) => !entry.item.enabled)}
      presence={<Presence marks={marks} />}
      quick={
        quick.length === 1 && quick[0] !== undefined ? (
          <QuickSkillSwitch entry={quick[0]} context={context} name={group.name} />
        ) : null
      }
    >
      {description ? <p className="text-body leading-relaxed text-fg-secondary">{description}</p> : null}
      <Part label="Harnesses">
        <Copies>
          {group.entries.map((entry) => (
            <SkillCopy key={`${entry.harness.provider}:${entry.item.path}`} entry={entry} context={context} />
          ))}
        </Copies>
        <AddTo group={group} context={context} kind="skills" />
      </Part>
    </GroupRow>
  );
}

function useSkillSwitch(entry: HubEntry<HubSkill>, context: HubContext) {
  const setSkill = useAtomSet(setHubSkill, { mode: "promise" });
  const { harness, item } = entry;
  return useSaving(
    item,
    item.enabled,
    (enabled) =>
      setSkill({
        payload: { provider: harness.provider, project: context.project, path: item.path, enabled },
      }),
    context.onChanged,
  );
}

function QuickSkillSwitch({
  entry,
  context,
  name,
}: {
  entry: HubEntry<HubSkill>;
  context: HubContext;
  name: string;
}) {
  const { enabled, toggle, error } = useSkillSwitch(entry, context);
  const labelId = useId();
  return (
    <span title={error} className="flex items-center">
      <span id={labelId} className="sr-only">
        {name} in {harnessName[entry.harness.provider]}
      </span>
      <CopySwitch
        harness={entry.harness}
        kind="skills"
        checked={enabled}
        onCheckedChange={toggle}
        labelledBy={labelId}
        compact
      />
    </span>
  );
}

function SkillCopy({ entry, context }: { entry: HubEntry<HubSkill>; context: HubContext }) {
  const { enabled, toggle, error } = useSkillSwitch(entry, context);
  const labelId = useId();
  return (
    <CopyLine
      provider={entry.harness.provider}
      scope={entry.item.scope}
      file={inProject(entry.item.path, context.project)}
      control={
        <CopySwitch
          harness={entry.harness}
          kind="skills"
          checked={enabled}
          onCheckedChange={toggle}
          labelledBy={labelId}
        />
      }
      error={error}
      labelId={labelId}
    />
  );
}
