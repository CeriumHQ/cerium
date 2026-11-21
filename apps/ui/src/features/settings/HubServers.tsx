import { Button } from "@base-ui/react/button";
import type { HubSecret, HubServer } from "@cerium/protocol";
import { useAtomRefresh, useAtomSet } from "@effect/atom-react";
import { useId, useState } from "react";

import { hubStatusAtom, hubStatusKey, setHubServer, setHubTool } from "../../backend/hub.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { harnessName } from "./Harnesses.tsx";
import { AddTo } from "./HubAddTo.tsx";
import { serverGist, serverLine, type HubEntry, type HubGroup } from "./hubModel.ts";
import {
  Copies,
  CopyLine,
  CopySwitch,
  GroupRow,
  inProject,
  limitOf,
  lockedHere,
  Part,
  Presence,
  useSaving,
  type HubContext,
  type Mark,
} from "./hubRows.tsx";
import { SettingsSwitch } from "./parts.tsx";

// Settings → MCP servers' rows: a server's config, each harness's copy with its connection, and its
// tools across harnesses.

const connectionLook = {
  connected: { dot: "bg-success", label: "Connected" },
  starting: { dot: "bg-running", label: "Starting" },
  failed: { dot: "bg-error", label: "Failed" },
  needsAuth: { dot: "bg-attention", label: "Needs sign-in" },
  disabled: { dot: "bg-line-strong", label: "Off" },
} as const;

const statusOf = (entry: HubEntry<HubServer>, context: HubContext) =>
  context.live.get(entry.harness.provider)?.statuses?.find((each) => each.name === entry.item.name);

export function ServerGroupRow({ group, context }: { group: HubGroup<HubServer>; context: HubContext }) {
  const [first] = group.entries;
  if (first === undefined) return null;
  const server = first.item;
  const quick = group.entries.filter((entry) => entry.harness.provider === context.picked);
  const marks = group.entries.map((entry): Mark => {
    const status = statusOf(entry, context);
    const look = status === undefined ? undefined : connectionLook[status.connection];
    const problem = status?.connection === "failed" || status?.connection === "needsAuth";
    return {
      provider: entry.harness.provider,
      on: entry.item.enabled,
      dot: entry.item.enabled && problem ? look?.dot : undefined,
      label: `${harnessName[entry.harness.provider]}: ${!entry.item.enabled ? "Off" : (look?.label ?? "On")}`,
    };
  });
  return (
    <GroupRow
      name={group.name}
      line={serverGist(server)}
      off={group.entries.every((entry) => !entry.item.enabled)}
      presence={<Presence marks={marks} />}
      quick={
        quick.length === 1 && quick[0] !== undefined ? (
          <QuickServerSwitch entry={quick[0]} context={context} name={group.name} />
        ) : null
      }
    >
      <ServerConfig server={server} />
      <Part label="Harnesses">
        <Copies>
          {group.entries.map((entry) => (
            <ServerCopy
              key={`${entry.harness.provider}:${entry.item.scope}`}
              entry={entry}
              context={context}
            />
          ))}
        </Copies>
        <AddTo group={group} context={context} kind="servers" />
      </Part>
      <ToolMatrix group={group} context={context} />
    </GroupRow>
  );
}

/** Turns a server on or off in one harness, and reads that harness's connections again after. */
function useServerSwitch(entry: HubEntry<HubServer>, context: HubContext) {
  const setServer = useAtomSet(setHubServer, { mode: "promise" });
  const refreshStatus = useAtomRefresh(hubStatusAtom(hubStatusKey(entry.harness.provider, context.project)));
  const { harness, item } = entry;
  return useSaving(
    item,
    item.enabled,
    (enabled) =>
      setServer({
        payload: {
          provider: harness.provider,
          project: context.project,
          name: item.name,
          scope: item.scope,
          enabled,
        },
      }),
    () => {
      context.onChanged();
      if (harness.support.status) refreshStatus();
    },
  );
}

function QuickServerSwitch({
  entry,
  context,
  name,
}: {
  entry: HubEntry<HubServer>;
  context: HubContext;
  name: string;
}) {
  const { enabled, toggle, error } = useServerSwitch(entry, context);
  const labelId = useId();
  return (
    <span title={error} className="flex items-center">
      <span id={labelId} className="sr-only">
        {name} in {harnessName[entry.harness.provider]}
      </span>
      <CopySwitch
        harness={entry.harness}
        kind="servers"
        checked={enabled}
        onCheckedChange={toggle}
        labelledBy={labelId}
        compact
      />
    </span>
  );
}

function ServerCopy({ entry, context }: { entry: HubEntry<HubServer>; context: HubContext }) {
  const { enabled, toggle, error } = useServerSwitch(entry, context);
  const labelId = useId();
  const status = statusOf(entry, context);
  const live = context.live.get(entry.harness.provider);
  const look = status === undefined ? undefined : connectionLook[status.connection];
  const state = !enabled ? null : look !== undefined ? (
    <span className="flex shrink-0 items-center gap-1.5 text-meta text-fg-tertiary">
      <span className={`size-1.5 rounded-full ${look.dot}`} />
      {look.label}
    </span>
  ) : live?.waiting === true ? (
    <span className="shrink-0 text-meta text-fg-tertiary">Connecting…</span>
  ) : live?.failed !== undefined ? (
    <span className="shrink-0 text-meta text-fg-tertiary" title={live.failed}>
      No status
    </span>
  ) : null;
  return (
    <CopyLine
      provider={entry.harness.provider}
      scope={entry.item.scope}
      file={entry.item.file === undefined ? undefined : inProject(entry.item.file, context.project)}
      state={state}
      control={
        <CopySwitch
          harness={entry.harness}
          kind="servers"
          checked={enabled}
          onCheckedChange={toggle}
          labelledBy={labelId}
        />
      }
      error={error ?? (enabled ? status?.error : undefined)}
      labelId={labelId}
    />
  );
}

/** What a server runs or where it's reached, and the secrets it's given by name. */
function ServerConfig({ server }: { server: HubServer }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-md border border-line-subtle bg-surface-sunken px-3 py-2.5 text-meta">
      <dt className="text-fg-tertiary">{server.url !== undefined ? "URL" : "Runs"}</dt>
      <dd className="min-w-0 font-mono text-caption break-all text-fg-secondary">{serverLine(server)}</dd>
      {server.env.length > 0 ? (
        <>
          <dt className="text-fg-tertiary">Environment</dt>
          <dd className="min-w-0">
            <Secrets secrets={server.env} />
          </dd>
        </>
      ) : null}
      {server.headers.length > 0 ? (
        <>
          <dt className="text-fg-tertiary">Headers</dt>
          <dd className="min-w-0">
            <Secrets secrets={server.headers} />
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/** Environment variables or headers by name, each saying whether the config gives it a value. */
function Secrets({ secrets }: { secrets: ReadonlyArray<HubSecret> }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {secrets.map((secret) => (
        <span
          key={secret.name}
          className="flex items-center gap-1.5 rounded-md border border-line-subtle bg-surface-pane px-1.5 py-px"
        >
          <span className={`size-1.5 rounded-full ${secret.set ? "bg-success" : "bg-attention"}`} />
          <span className="font-mono text-caption text-fg-secondary">{secret.name}</span>
          <span className="sr-only">{secret.set ? "set" : "empty"}</span>
        </span>
      ))}
    </span>
  );
}

/** How many tools show before the rest are asked for. */
const TOOLS_SHOWN = 8;

/**
 * A server's tools, one row each, with a column per harness that reports them or has one turned off: a
 * switch where that harness can turn a single tool off, a dot where it offers the tool but can't.
 */
function ToolMatrix({ group, context }: { group: HubGroup<HubServer>; context: HubContext }) {
  const [all, setAll] = useState(false);
  const columns = group.entries.filter(
    (entry) => statusOf(entry, context)?.tools !== undefined || entry.item.disabledTools.length > 0,
  );
  const names = [
    ...new Set(
      columns.flatMap((entry) => [
        ...(statusOf(entry, context)?.tools ?? []).map((tool) => tool.name),
        ...entry.item.disabledTools,
      ]),
    ),
  ];
  if (names.length === 0) {
    const reporting = group.entries.find((entry) => entry.harness.support.status);
    if (reporting === undefined) return null;
    const live = context.live.get(reporting.harness.provider);
    return (
      <p className="text-meta text-fg-tertiary">
        {live?.statuses === undefined
          ? "Tools show once it connects."
          : group.entries.some((entry) => entry.item.enabled)
            ? "It reports no tools."
            : "Turn it on to see its tools."}
      </p>
    );
  }
  const describe = (tool: string) =>
    columns.flatMap((entry) => statusOf(entry, context)?.tools ?? []).find((each) => each.name === tool)
      ?.description;
  const shown = all || names.length <= TOOLS_SHOWN + 1 ? names : names.slice(0, TOOLS_SHOWN);
  const grid = { gridTemplateColumns: `minmax(0,1fr) repeat(${columns.length}, 2.75rem)` };
  return (
    <Part label="Tools" end={<span className="text-meta text-fg-tertiary tabular-nums">{names.length}</span>}>
      <div className="flex flex-col rounded-md border border-line-subtle bg-surface-sunken">
        {columns.length > 1 ? (
          <div style={grid} className="grid items-center border-b border-line-subtle px-3 py-1.5">
            <span />
            {columns.map((entry) => (
              <span
                key={`${entry.harness.provider}:${entry.item.scope}`}
                title={harnessName[entry.harness.provider]}
                className="flex justify-center"
              >
                <ProviderLogo provider={entry.harness.provider} size={13} />
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex flex-col divide-y divide-line-subtle">
          {shown.map((tool) => (
            <ToolRow
              key={tool}
              tool={tool}
              description={describe(tool)}
              columns={columns}
              grid={grid}
              context={context}
            />
          ))}
        </div>
        {shown.length < names.length ? (
          <Button
            onClick={() => setAll(true)}
            className="flex h-8 items-center justify-center border-t border-line-subtle text-meta text-fg-tertiary transition-colors hover:text-fg-primary"
          >
            Show all {names.length}
          </Button>
        ) : null}
      </div>
    </Part>
  );
}

function ToolRow({
  tool,
  description,
  columns,
  grid,
  context,
}: {
  tool: string;
  description: string | undefined;
  columns: ReadonlyArray<HubEntry<HubServer>>;
  grid: { gridTemplateColumns: string };
  context: HubContext;
}) {
  const labelId = useId();
  return (
    <div style={grid} className="grid min-h-9 items-center gap-y-0.5 px-3 py-1.5">
      <span className="flex min-w-0 flex-col">
        <span id={labelId} className="truncate font-mono text-caption text-fg-secondary">
          {tool}
        </span>
        {description ? (
          <span title={description} className="truncate text-caption text-fg-tertiary">
            {description}
          </span>
        ) : null}
      </span>
      {columns.map((entry) => (
        <span key={`${entry.harness.provider}:${entry.item.scope}`} className="flex justify-center">
          <ToolCell tool={tool} entry={entry} context={context} labelledBy={labelId} />
        </span>
      ))}
    </div>
  );
}

function ToolCell({
  tool,
  entry,
  context,
  labelledBy,
}: {
  tool: string;
  entry: HubEntry<HubServer>;
  context: HubContext;
  labelledBy: string;
}) {
  const setTool = useAtomSet(setHubTool, { mode: "promise" });
  const { harness, item } = entry;
  const { enabled, toggle } = useSaving(
    item,
    !item.disabledTools.includes(tool),
    (next) =>
      setTool({
        payload: {
          provider: harness.provider,
          project: context.project,
          name: item.name,
          scope: item.scope,
          tool,
          enabled: next,
        },
      }),
    context.onChanged,
  );
  const offered =
    item.disabledTools.includes(tool) ||
    (statusOf(entry, context)?.tools ?? []).some((each) => each.name === tool);
  if (!offered) {
    return (
      <span
        title={`${harnessName[harness.provider]} doesn't offer it`}
        className="text-meta text-fg-tertiary"
      >
        –
      </span>
    );
  }
  if (harness.support.tools === "none") {
    return <span title={limitOf(harness, "tools")} className="size-1.5 rounded-full bg-fg-tertiary" />;
  }
  return (
    <span title={lockedHere(harness, "tools") ? harness.locked : harnessName[harness.provider]}>
      <SettingsSwitch
        checked={enabled}
        onCheckedChange={toggle}
        disabled={lockedHere(harness, "tools")}
        labelledBy={labelledBy}
      />
    </span>
  );
}
