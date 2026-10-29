import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import { Popover } from "@base-ui/react/popover";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type {
  HubCopyOutcome,
  HubHarness,
  HubScope,
  HubSecret,
  HubServer,
  HubServerStatus,
  HubSkill,
  HubTargetScope,
  ProjectInfo,
  ProviderId,
} from "@cerium/protocol";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ChevronDown, Plus, RefreshCw } from "lucide-react";
import { use, useId, useState, type ReactNode } from "react";

import {
  copyHubServer,
  copyHubSkill,
  hubAtom,
  hubStatusAtom,
  hubStatusesAtom,
  hubStatusKey,
  setHubServer,
  setHubSkill,
  setHubTool,
} from "../../backend/hub.ts";
import { savedProjectsAtom } from "../../backend/projects.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { SearchBar } from "../../components/ui/SearchBar.tsx";
import { harnessName } from "./Harnesses.tsx";
import {
  filterHub,
  groupHub,
  serverGist,
  serverLine,
  type HubEntry,
  type HubGroup,
  type HubPlace,
} from "./hubModel.ts";
import { SettingsCard, SettingsNote, SettingsPage, SettingsProject, SettingsSwitch } from "./parts.tsx";
import { initialProject } from "./scriptsModel.ts";
import { RowButton } from "./ToolRow.tsx";
import { ProjectSelect } from "./SourceControl.tsx";

// Settings → MCP servers and Settings → Skills: every harness's servers or skills for one project, each
// listed once with the harnesses that have it, as their own configs say. A row opens onto each harness's
// copy with its switch, a server's tools across harnesses, and a way to add it to the harnesses without
// it. Switches show only where the harness itself can turn the thing off; where it can't, the row says so.

type Kind = "servers" | "skills";

const pageCopy: Record<Kind, { title: string; description: string; empty: string; search: string }> = {
  servers: {
    title: "MCP servers",
    description:
      "Every harness's servers for a project, edited in its own config. Secrets stay there: only whether one is set shows.",
    empty: "No harness has an MCP server for this project.",
    search: "Search servers",
  },
  skills: {
    title: "Skills",
    description: "Every harness's skills for a project, read from its own folders.",
    empty: "No harness has a skill for this project.",
    search: "Search skills",
  },
};

/** The answer a harness gives when its CLI isn't there, which the page lists in one line at the end. */
const NOT_INSTALLED = "Not installed.";

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Something went wrong. Try again.";

const scopeLabel: Record<HubScope, string> = {
  user: "User",
  project: "Project",
  local: "Local",
  bundled: "Built-in",
};

const scopeHint: Record<HubScope, string> = {
  user: "In every project",
  project: "In the project's files, shared with whoever clones it",
  local: "In this project, on this machine only",
  bundled: "From the harness or a plugin",
};

const placeTitle: Record<HubPlace, string> = {
  project: "This project",
  user: "All projects",
  bundled: "Built-in",
};

export const McpSettings = () => <HubSettings kind="servers" />;
export const SkillsSettings = () => <HubSettings kind="skills" />;

function HubSettings({ kind }: { kind: Kind }) {
  const listed = useAtomValue(savedProjectsAtom);
  const from = use(SettingsProject);
  const [picked, setPicked] = useState<string>();
  const projects = AsyncResult.getOrElse(listed, (): ReadonlyArray<ProjectInfo> => []).filter(
    (project) => project.missing !== true,
  );
  const paths = projects.map((project) => project.path);
  const shown = picked !== undefined && paths.includes(picked) ? picked : initialProject(paths, from);
  return (
    <SettingsPage
      perMachine
      title={pageCopy[kind].title}
      description={pageCopy[kind].description}
      action={
        shown === undefined ? null : (
          <div className="flex items-center gap-1.5">
            <RefreshHub project={shown} />
            <ProjectSelect projects={paths} shown={shown} onPick={setPicked} />
          </div>
        )
      }
    >
      {shown === undefined ? (
        <SettingsNote>
          No projects yet. Open a folder in a new thread to see its{" "}
          {kind === "servers" ? "servers" : "skills"}.
        </SettingsNote>
      ) : (
        <HubBody key={shown} project={shown} kind={kind} />
      )}
    </SettingsPage>
  );
}

/** Reads every harness's config again, for a change made outside Cerium. */
function RefreshHub({ project }: { project: string }) {
  const refresh = useAtomRefresh(hubAtom(project));
  return <IconButton icon={RefreshCw} label="Read again" onClick={refresh} />;
}

/** A harness's live report on its servers, once it has started each. */
interface Live {
  readonly statuses: ReadonlyArray<HubServerStatus> | undefined;
  readonly waiting: boolean;
  readonly failed: string | undefined;
}

/** What every row of a page needs from it. */
interface HubContext {
  readonly project: string;
  /** The harnesses whose config could be read, which a server or skill can be added to. */
  readonly harnesses: ReadonlyArray<HubHarness>;
  readonly live: ReadonlyMap<ProviderId, Live>;
  /** The harness the list is narrowed to, whose switch each row then shows without opening. */
  readonly picked: ProviderId | undefined;
  readonly onChanged: () => void;
}

/** The search and harness filter, the list under its places, then the harnesses not installed. */
function HubBody({ project, kind }: { project: string; kind: Kind }) {
  const result = useAtomValue(hubAtom(project));
  const refresh = useAtomRefresh(hubAtom(project));
  const reports = useAtomValue(hubStatusesAtom(project));
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<ProviderId>();
  const harnesses = AsyncResult.getOrElse(result, (): ReadonlyArray<HubHarness> | undefined => undefined);
  if (harnesses === undefined) {
    return AsyncResult.isFailure(result) ? (
      <SettingsNote tone="error">{messageOf(result.cause)}</SettingsNote>
    ) : (
      <SettingsNote>Reading each harness's config…</SettingsNote>
    );
  }
  const readable = harnesses.filter((harness) => harness.unavailable === undefined);
  const missing = harnesses.filter((harness) => harness.unavailable === NOT_INSTALLED);
  const picked = readable.some((harness) => harness.provider === provider) ? provider : undefined;
  const live = new Map(
    [...reports].map(([each, report]): [ProviderId, Live] => [
      each,
      {
        statuses: AsyncResult.getOrElse(report, (): ReadonlyArray<HubServerStatus> | undefined => undefined),
        waiting: report.waiting,
        failed: AsyncResult.isFailure(report) ? messageOf(report.cause) : undefined,
      },
    ]),
  );
  const context: HubContext = { project, harnesses: readable, live, picked, onChanged: refresh };
  const servers = groupHub(readable, (harness) => harness.servers);
  const skills = groupHub(readable, (harness) => harness.skills);
  const total = kind === "servers" ? servers.length : skills.length;
  const filter = { query, provider: picked };

  return (
    <>
      {total === 0 ? (
        <SettingsNote>{pageCopy[kind].empty}</SettingsNote>
      ) : (
        <div className="-mt-2 flex flex-col gap-3">
          <div className="overflow-hidden rounded-lg border border-line-subtle bg-surface-sunken [&>div]:h-9 [&>div]:border-b-0 [&>div]:pl-3">
            <SearchBar value={query} onChange={setQuery} placeholder={pageCopy[kind].search} />
          </div>
          <HarnessFilter
            kind={kind}
            harnesses={readable}
            total={total}
            picked={picked}
            live={live}
            onPick={setProvider}
          />
        </div>
      )}
      {kind === "servers" ? (
        <Places
          groups={filterHub(servers, filter)}
          query={query}
          total={total}
          row={(group) => <ServerGroupRow key={group.key} group={group} context={context} />}
        />
      ) : (
        <Places
          groups={filterHub(skills, filter)}
          query={query}
          total={total}
          row={(group) => <SkillGroupRow key={group.key} group={group} context={context} />}
        />
      )}
      {missing.length > 0 ? (
        <p className="-mt-2 px-1 text-meta text-fg-tertiary">
          Not installed: {missing.map((each) => harnessName[each.provider]).join(", ")}.
        </p>
      ) : null}
    </>
  );
}

/** Narrows the list to one harness's servers or skills, each chip counting them. */
function HarnessFilter({
  kind,
  harnesses,
  total,
  picked,
  live,
  onPick,
}: {
  kind: Kind;
  harnesses: ReadonlyArray<HubHarness>;
  total: number;
  picked: ProviderId | undefined;
  live: ReadonlyMap<ProviderId, Live>;
  onPick: (provider: ProviderId | undefined) => void;
}) {
  const chip =
    "flex h-7 items-center gap-1.5 rounded-full border border-line-subtle px-2.5 text-meta text-fg-secondary transition-colors duration-150 select-none hover:bg-surface-hover hover:text-fg-primary data-pressed:border-transparent data-pressed:bg-surface-selected data-pressed:text-fg-primary";
  return (
    <ToggleGroup
      value={[picked ?? "all"]}
      onValueChange={(value) => onPick(harnesses.find((each) => each.provider === value[0])?.provider)}
      aria-label="Harness"
      className="flex flex-wrap items-center gap-1.5"
    >
      <Toggle value="all" className={chip}>
        All <span className="text-fg-tertiary tabular-nums">{total}</span>
      </Toggle>
      {harnesses.map((harness) => {
        const count = kind === "servers" ? harness.servers.length : harness.skills.length;
        const connecting = kind === "servers" && live.get(harness.provider)?.waiting === true;
        return (
          <Toggle key={harness.provider} value={harness.provider} className={chip}>
            <ProviderLogo provider={harness.provider} size={13} />
            {harnessName[harness.provider]}
            <span className="text-fg-tertiary tabular-nums">{count}</span>
            {connecting ? (
              <span
                title="Connecting…"
                className="size-1.5 animate-pulse rounded-full bg-running motion-reduce:animate-none"
              />
            ) : null}
          </Toggle>
        );
      })}
    </ToggleGroup>
  );
}

/** The groups under where they're configured: this project's, every project's, then built-in ones. */
function Places<T>({
  groups,
  query,
  total,
  row,
}: {
  groups: ReadonlyArray<HubGroup<T>>;
  query: string;
  total: number;
  row: (group: HubGroup<T>) => ReactNode;
}) {
  if (total === 0) return null;
  if (groups.length === 0) {
    return (
      <SettingsNote>
        {query.trim() === "" ? "None in this harness." : `Nothing matches “${query.trim()}”.`}
      </SettingsNote>
    );
  }
  return (["project", "user", "bundled"] as const).map((place) => {
    const shown = groups.filter((group) => group.place === place);
    if (shown.length === 0) return null;
    return (
      <section key={place} className="flex flex-col gap-2">
        <h2 className="flex items-baseline gap-1.5 px-1 text-meta font-medium text-fg-secondary">
          {placeTitle[place]}
          <span className="font-normal text-fg-tertiary tabular-nums">{shown.length}</span>
        </h2>
        <FoldedList rows={shown.map(row)} />
      </section>
    );
  });
}

/** How many rows a long list shows before the rest are asked for. */
const FOLD_AFTER = 8;

/** A card of rows that shows the first few of a long list, and the rest on request. */
function FoldedList({ rows }: { rows: ReadonlyArray<ReactNode> }) {
  const [all, setAll] = useState(false);
  // One more row than the fold would hide is shown instead: "Show 1 more" saves no room.
  const folded = !all && rows.length > FOLD_AFTER + 1;
  return (
    <SettingsCard className="flex flex-col divide-y divide-line-subtle overflow-hidden">
      {folded ? rows.slice(0, FOLD_AFTER) : rows}
      {folded ? (
        <Button
          onClick={() => setAll(true)}
          className="flex h-10 items-center justify-center text-meta text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary"
        >
          Show {rows.length - FOLD_AFTER} more
        </Button>
      ) : null}
    </SettingsCard>
  );
}

/**
 * A server or skill: its name and a line on it, the harnesses that have it, and their copies folded
 * under it until it's opened. With the list narrowed to one harness, that harness's switch sits on the row.
 */
function GroupRow({
  name,
  line,
  off,
  presence,
  quick,
  children,
}: {
  name: string;
  line: string | undefined;
  off: boolean;
  presence: ReactNode;
  quick: ReactNode;
  children: ReactNode;
}) {
  return (
    <Collapsible.Root className="group/row">
      <div className="flex items-center gap-3 pr-4 transition-colors hover:bg-surface-hover/60 has-data-panel-open:bg-surface-hover/40">
        <Collapsible.Trigger className="group flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span
              className={`truncate text-body font-medium ${off ? "text-fg-tertiary" : "text-fg-primary"}`}
            >
              {name}
            </span>
            {line ? (
              <span title={line} className="truncate text-meta text-fg-tertiary group-data-panel-open:hidden">
                {line}
              </span>
            ) : null}
          </span>
          {presence}
          <ChevronDown
            size={14}
            strokeWidth={2}
            className="shrink-0 text-fg-tertiary transition-transform duration-200 ease-out-soft group-data-panel-open:rotate-180 motion-reduce:transition-none"
          />
        </Collapsible.Trigger>
        {quick}
      </div>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
        <div className="flex flex-col gap-4 px-4 pt-1 pb-4">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** One harness's mark on a row: lit while it's on there, with a dot when its connection needs a look. */
interface Mark {
  readonly provider: ProviderId;
  readonly on: boolean;
  readonly dot: string | undefined;
  readonly label: string;
}

/** The harnesses that have a server or skill, once each however many scopes it sits in there. */
function Presence({ marks }: { marks: ReadonlyArray<Mark> }) {
  const once = marks.filter((mark, at) => marks.findIndex((each) => each.provider === mark.provider) === at);
  return (
    <span className="flex shrink-0 items-center gap-1">
      {once.map((mark) => {
        const on = marks.some((each) => each.provider === mark.provider && each.on);
        return (
          <span
            key={mark.provider}
            title={mark.label}
            className={`relative grid size-6 place-items-center rounded-md ${on ? "bg-surface-raised" : ""}`}
          >
            <ProviderLogo provider={mark.provider} size={13} className={on ? "" : "opacity-35 grayscale"} />
            {mark.dot !== undefined ? (
              <span
                className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface-panel ${mark.dot}`}
              />
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

/** A small heading over a part of an open row. */
function Part({ label, end, children }: { label: string; end?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-meta font-medium text-fg-tertiary">{label}</span>
        {end}
      </div>
      {children}
    </div>
  );
}

/** Each harness's copy of an open row, one line each. */
function Copies({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle bg-surface-sunken">
      {children}
    </div>
  );
}

/** One harness's copy: the harness, where it's configured, its state and its switch. */
function CopyLine({
  provider,
  scope,
  file,
  state,
  control,
  error,
  labelId,
}: {
  provider: ProviderId;
  scope: HubScope;
  file: string | undefined;
  state?: ReactNode;
  control: ReactNode;
  error: string | undefined;
  labelId: string;
}) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex min-h-6 items-center gap-2.5">
        <ProviderLogo provider={provider} size={14} />
        <span id={labelId} className="shrink-0 text-body text-fg-primary">
          {harnessName[provider]}
        </span>
        <span
          title={scopeHint[scope]}
          className="shrink-0 rounded border border-line-subtle px-1.5 text-caption text-fg-tertiary"
        >
          {scopeLabel[scope]}
        </span>
        <span title={file} className="min-w-0 flex-1 truncate font-mono text-caption text-fg-tertiary">
          {file}
        </span>
        {state}
        {control}
      </div>
      {error ? <p className="pl-6 text-meta text-error-text">{error}</p> : null}
    </div>
  );
}

/**
 * A change the switch shows at once while it saves: kept until the harness's config is read again, when
 * the switch has a new `of` and shows what the file now says.
 */
interface Saving<T> {
  readonly of: T;
  readonly value: boolean;
}

/** A switch's state while a change to it saves, and why the last one didn't. */
function useSaving<T>(
  of: T,
  current: boolean,
  save: (next: boolean) => Promise<unknown>,
  onSaved: () => void,
) {
  const [saving, setSaving] = useState<Saving<T>>();
  const [error, setError] = useState<string>();
  const toggle = (next: boolean) => {
    setError(undefined);
    setSaving({ of, value: next });
    save(next).then(onSaved, (failure: unknown) => {
      setSaving(undefined);
      setError(messageOf(failure));
    });
  };
  return { enabled: saving?.of === of ? saving.value : current, toggle, error };
}

/** What a harness can't turn off natively, said where its switch would be. */
const limitOf = (harness: HubHarness, kind: "servers" | "tools" | "skills"): string | undefined => {
  const name = harnessName[harness.provider];
  const level = harness.support[kind];
  if (kind === "servers" && level === "none") return `${name} has no switch per project for servers.`;
  if (kind === "tools" && level === "none") return `${name} can't turn off a single tool.`;
  if (kind === "skills" && level === "none")
    return `${name} has no switch for skills: remove one from its folder instead.`;
  if (kind === "skills" && level === "everywhere")
    return `${name} turns a skill off in every project at once.`;
  return undefined;
};

/** Whether a switch that works per project is held off in this one, as `locked` says why. */
const lockedHere = (harness: HubHarness, kind: "servers" | "tools" | "skills") =>
  harness.locked !== undefined && harness.support[kind] === "project";

/** A copy's switch, or why there's none: held off for now, or not something the harness can turn off. */
function CopySwitch({
  harness,
  kind,
  checked,
  onCheckedChange,
  labelledBy,
  compact = false,
}: {
  harness: HubHarness;
  kind: "servers" | "skills";
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  labelledBy: string;
  /** On a list's row, where a word beside every switch would repeat down the list: the tooltip says it. */
  compact?: boolean;
}) {
  if (harness.support[kind] === "none") {
    return (
      <span title={limitOf(harness, kind)} className="shrink-0 text-meta text-fg-tertiary">
        Always on
      </span>
    );
  }
  const locked = lockedHere(harness, kind);
  const note = locked ? harness.locked : limitOf(harness, kind);
  return (
    <span title={note} className="flex shrink-0 items-center gap-2">
      {harness.support[kind] === "everywhere" && !compact ? (
        <span className="text-caption text-fg-tertiary">All projects</span>
      ) : null}
      <SettingsSwitch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={locked}
        labelledBy={labelledBy}
      />
    </span>
  );
}

/** A path inside the project from its folder, as `.cursor/mcp.json`; any other in full. */
const inProject = (path: string, project: string) => {
  const plain = (each: string) => each.replaceAll("\\", "/").replace(/\/+$/, "");
  const [file, folder] = [plain(path), plain(project)];
  return file.toLowerCase().startsWith(`${folder.toLowerCase()}/`) ? file.slice(folder.length + 1) : path;
};

// Servers

const connectionLook = {
  connected: { dot: "bg-success", label: "Connected" },
  starting: { dot: "bg-running", label: "Starting" },
  failed: { dot: "bg-error", label: "Failed" },
  needsAuth: { dot: "bg-attention", label: "Needs sign-in" },
  disabled: { dot: "bg-line-strong", label: "Off" },
} as const;

const statusOf = (entry: HubEntry<HubServer>, context: HubContext) =>
  context.live.get(entry.harness.provider)?.statuses?.find((each) => each.name === entry.item.name);

function ServerGroupRow({ group, context }: { group: HubGroup<HubServer>; context: HubContext }) {
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

// Skills

function SkillGroupRow({ group, context }: { group: HubGroup<HubSkill>; context: HubContext }) {
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

// Adding to other harnesses

/** A button for each harness that could have the server or skill and doesn't, which copies it there. */
function AddTo<T extends HubServer | HubSkill>({
  group,
  context,
  kind,
}: {
  group: HubGroup<T>;
  context: HubContext;
  kind: Kind;
}) {
  const source = group.entries.find((entry) => entry.item.scope !== "bundled");
  const missing = context.harnesses
    .map((harness) => harness.provider)
    .filter((provider) => !group.entries.some((entry) => entry.harness.provider === provider));
  if (source === undefined || missing.length === 0) return null;
  const { harness, item } = source;
  const secrets = "env" in item && item.env.length + item.headers.length > 0;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="mr-0.5 text-meta text-fg-tertiary">Add to</span>
      {missing.map((provider) => (
        <AddButton
          key={provider}
          what={group.name}
          to={provider}
          from={item.scope}
          project={context.project}
          secrets={secrets}
          copy={(scope) =>
            kind === "servers"
              ? {
                  kind: "server",
                  payload: {
                    provider: harness.provider,
                    project: context.project,
                    name: item.name,
                    scope: item.scope,
                    to: [{ provider, scope }],
                  },
                }
              : {
                  kind: "skill",
                  payload: {
                    provider: harness.provider,
                    project: context.project,
                    path: "path" in item ? item.path : "",
                    to: [{ provider, scope }],
                  },
                }
          }
          onCopied={context.onChanged}
        />
      ))}
    </div>
  );
}

type CopyRequest =
  | {
      kind: "server";
      payload: {
        provider: ProviderId;
        project: string;
        name: string;
        scope: HubScope;
        to: ReadonlyArray<{ provider: ProviderId; scope: HubTargetScope }>;
      };
    }
  | {
      kind: "skill";
      payload: {
        provider: ProviderId;
        project: string;
        path: string;
        to: ReadonlyArray<{ provider: ProviderId; scope: HubTargetScope }>;
      };
    };

/**
 * Copies a server or skill into one more harness, in its own format, for this project or every one; then
 * says where the copy went and what's left to fill in.
 */
function AddButton({
  what,
  to,
  from,
  project,
  secrets,
  copy,
  onCopied,
}: {
  what: string;
  to: ProviderId;
  from: HubScope;
  project: string;
  secrets: boolean;
  copy: (scope: HubTargetScope) => CopyRequest;
  onCopied: () => void;
}) {
  const copyServer = useAtomSet(copyHubServer, { mode: "promise" });
  const copySkill = useAtomSet(copyHubSkill, { mode: "promise" });
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<HubTargetScope>(from === "user" ? "user" : "project");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<HubCopyOutcome>();
  const [error, setError] = useState<string>();

  const start = () => {
    const request = copy(scope);
    setBusy(true);
    setError(undefined);
    const sent =
      request.kind === "server"
        ? copyServer({ payload: request.payload })
        : copySkill({ payload: request.payload });
    sent.then(
      (done) => {
        setBusy(false);
        setOutcome(done.find((each) => each.provider === to));
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure));
      },
    );
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          // The list is read again only once the outcome is closed: the copy takes this button away.
          if (outcome !== undefined) onCopied();
          setOutcome(undefined);
          setError(undefined);
        }
      }}
    >
      <Popover.Trigger
        render={<Button />}
        className="flex h-7 items-center gap-1.5 rounded-full border border-dashed border-line-strong pr-2.5 pl-2 text-meta text-fg-secondary transition-colors hover:border-solid hover:bg-surface-hover hover:text-fg-primary data-popup-open:border-solid data-popup-open:bg-surface-hover data-popup-open:text-fg-primary"
      >
        <Plus size={12} strokeWidth={2} className="text-fg-tertiary" />
        <ProviderLogo provider={to} size={13} />
        {harnessName[to]}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50 outline-none">
          <Popover.Popup
            aria-label={`Add ${what} to ${harnessName[to]}`}
            className="flex w-72 max-w-[calc(100vw-1rem)] origin-(--transform-origin) flex-col gap-3 rounded-xl border border-line-subtle bg-surface-overlay p-3.5 text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0"
          >
            <span className="flex min-w-0 items-center gap-2 text-body font-medium">
              <ProviderLogo provider={to} size={14} />
              <span className="truncate">
                Add {what} to {harnessName[to]}
              </span>
            </span>
            {outcome === undefined ? (
              <>
                <ToggleGroup
                  value={[scope]}
                  onValueChange={(value) => {
                    const next = value[0];
                    if (next === "project" || next === "user") setScope(next);
                  }}
                  aria-label="Where"
                  className="flex items-center gap-0.5 self-start rounded-lg border border-line-subtle p-0.5"
                >
                  {(["project", "user"] as const).map((each) => (
                    <Toggle
                      key={each}
                      value={each}
                      className="rounded-md px-2 py-0.5 text-meta font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary"
                    >
                      {each === "project" ? "This project" : "All projects"}
                    </Toggle>
                  ))}
                </ToggleGroup>
                {secrets ? (
                  <p className="text-meta leading-relaxed text-fg-tertiary">
                    Secrets aren't copied: the copy names them for you to fill in.
                  </p>
                ) : null}
                {error ? <p className="text-meta text-error-text">{error}</p> : null}
                <div className="flex justify-end">
                  <RowButton tone="primary" onClick={start} disabled={busy}>
                    {busy ? "Adding…" : "Add"}
                  </RowButton>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-1 text-meta">
                  {outcome.skipped !== undefined ? (
                    <span className="text-fg-tertiary">{outcome.skipped}</span>
                  ) : (
                    <>
                      <span className="text-fg-tertiary">
                        Added to{" "}
                        <span
                          className="font-mono text-caption break-all text-fg-secondary"
                          title={outcome.wrote}
                        >
                          {outcome.wrote === undefined ? "" : inProject(outcome.wrote, project)}
                        </span>
                      </span>
                      {outcome.fill.length > 0 ? (
                        <span className="text-attention-text">Fill in {outcome.fill.join(", ")} there.</span>
                      ) : null}
                    </>
                  )}
                </div>
                <div className="flex justify-end">
                  <RowButton onClick={() => setOpen(false)}>Done</RowButton>
                </div>
              </>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
