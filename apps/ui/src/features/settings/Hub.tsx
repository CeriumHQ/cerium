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
import { ChevronRight, RefreshCw } from "lucide-react";
import { use, useState, type ReactNode } from "react";

import {
  copyHubServer,
  copyHubSkill,
  hubAtom,
  hubStatusAtom,
  hubStatusKey,
  setHubServer,
  setHubSkill,
  setHubTool,
} from "../../backend/hub.ts";
import { savedProjectsAtom } from "../../backend/projects.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { DialogCheck } from "../../components/ui/FormDialog.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { harnessName } from "./Harnesses.tsx";
import {
  SettingsCard,
  SettingsNote,
  SettingsPage,
  SettingsProject,
  SettingsSection,
  SettingsSwitch,
} from "./parts.tsx";
import { initialProject } from "./scriptsModel.ts";
import { RowButton } from "./ToolRow.tsx";
import { ProjectSelect } from "./SourceControl.tsx";

// Settings → MCP & skills: each harness's MCP servers and skills for one project, as its own config
// has them. A list first, a row's command, secrets, tools and copy on demand. Switches show only where
// the harness itself can turn the thing off; where it can't, the section says so.

type View = "servers" | "skills";

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

const transportLabel = { stdio: "stdio", http: "HTTP", sse: "SSE" } as const;

const scopeOrder: Record<HubScope, number> = { project: 0, local: 1, user: 2, bundled: 3 };

/** The project's own first and the harness's built-in ones last, each harness's order kept within. */
const byScope = <T extends { readonly scope: HubScope }>(items: ReadonlyArray<T>) =>
  items.toSorted((a, b) => scopeOrder[a.scope] - scopeOrder[b.scope]);

export function HubSettings() {
  const listed = useAtomValue(savedProjectsAtom);
  const from = use(SettingsProject);
  const [picked, setPicked] = useState<string>();
  const [view, setView] = useState<View>("servers");
  const projects = AsyncResult.getOrElse(listed, (): ReadonlyArray<ProjectInfo> => []).filter(
    (project) => project.missing !== true,
  );
  const paths = projects.map((project) => project.path);
  const shown = picked !== undefined && paths.includes(picked) ? picked : initialProject(paths, from);
  return (
    <SettingsPage
      perMachine
      title="MCP & skills"
      description="Each harness keeps its own config, which Cerium edits in place. Secrets stay in those files: only whether one is set shows here."
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
          No projects yet. Open a folder in a new thread to see its servers and skills.
        </SettingsNote>
      ) : (
        <>
          <ToggleGroup
            value={[view]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "servers" || next === "skills") setView(next);
            }}
            aria-label="Show"
            className="-mb-3 flex items-center gap-0.5 self-start rounded-lg border border-line-subtle p-0.5"
          >
            {(["servers", "skills"] as const).map((each) => (
              <Toggle
                key={each}
                value={each}
                className="rounded-md px-2.5 py-0.5 text-meta font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary"
              >
                {each === "servers" ? "MCP servers" : "Skills"}
              </Toggle>
            ))}
          </ToggleGroup>
          <HubList key={shown} project={shown} view={view} />
        </>
      )}
    </SettingsPage>
  );
}

/** Reads every harness's config again, for a change made outside Cerium. */
function RefreshHub({ project }: { project: string }) {
  const refresh = useAtomRefresh(hubAtom(project));
  return <IconButton icon={RefreshCw} label="Read again" onClick={refresh} />;
}

/** Every harness's section for the project, then the ones that aren't installed, in a line. */
function HubList({ project, view }: { project: string; view: View }) {
  const result = useAtomValue(hubAtom(project));
  const refresh = useAtomRefresh(hubAtom(project));
  const harnesses = AsyncResult.getOrElse(result, (): ReadonlyArray<HubHarness> | undefined => undefined);
  if (harnesses === undefined) {
    return AsyncResult.isFailure(result) ? (
      <SettingsNote tone="error">{messageOf(result.cause)}</SettingsNote>
    ) : (
      <SettingsNote>Reading each harness's config…</SettingsNote>
    );
  }
  const shown = harnesses.filter((harness) => harness.unavailable !== NOT_INSTALLED);
  const missing = harnesses.filter((harness) => harness.unavailable === NOT_INSTALLED);
  const targets = shown.filter((harness) => harness.unavailable === undefined).map((each) => each.provider);
  return (
    <>
      {shown.map((harness) => (
        <HarnessSection
          key={harness.provider}
          harness={harness}
          project={project}
          view={view}
          targets={targets.filter((each) => each !== harness.provider)}
          onChanged={refresh}
        />
      ))}
      {missing.length > 0 ? (
        <p className="-mt-3 text-meta text-fg-tertiary">
          Not installed: {missing.map((each) => harnessName[each.provider]).join(", ")}.
        </p>
      ) : null}
    </>
  );
}

/** What a harness can't turn off natively, said once over its list instead of offering a fake switch. */
const limitsOf = (harness: HubHarness, view: View): string | undefined => {
  const name = harnessName[harness.provider];
  const { servers, tools, skills } = harness.support;
  if (view === "servers") {
    if (servers === "none") return `${name} has no switch per project for servers or their tools.`;
    if (tools === "none") return `${name} can't turn off a single tool.`;
    return undefined;
  }
  if (skills === "none") return `${name} has no switch for skills: remove one from its folder instead.`;
  if (skills === "everywhere") return `${name} turns a skill off in every project at once.`;
  return undefined;
};

/** Whether a switch that works per project is held off in this one, as `locked` says why. */
const lockedHere = (harness: HubHarness, kind: "servers" | "tools" | "skills") =>
  harness.locked !== undefined && harness.support[kind] === "project";

interface SectionProps {
  harness: HubHarness;
  project: string;
  view: View;
  /** The harnesses a server or skill can be copied to. */
  targets: ReadonlyArray<ProviderId>;
  onChanged: () => void;
}

function HarnessSection(props: SectionProps) {
  const { harness, view } = props;
  const count = view === "servers" ? harness.servers.length : harness.skills.length;
  const locked =
    view === "servers"
      ? lockedHere(harness, "servers") || lockedHere(harness, "tools")
      : lockedHere(harness, "skills");
  const notes = [limitsOf(harness, view), locked ? harness.locked : undefined]
    .filter((each) => each !== undefined)
    .join(" ");
  const title = (
    <>
      <ProviderLogo provider={harness.provider} size={15} />
      {harnessName[harness.provider]}
      {harness.unavailable === undefined ? (
        <span className="font-normal text-fg-tertiary tabular-nums">{count}</span>
      ) : null}
    </>
  );
  if (harness.unavailable !== undefined) {
    return (
      <SettingsSection title={title}>
        <SettingsNote>{harness.unavailable}</SettingsNote>
      </SettingsSection>
    );
  }
  if (count === 0) {
    return (
      <SettingsSection title={title}>
        <SettingsNote>{view === "servers" ? "No MCP servers." : "No skills."}</SettingsNote>
      </SettingsSection>
    );
  }
  if (view === "skills") {
    return (
      <SettingsSection title={title} {...(notes ? { description: notes } : {})}>
        <FoldedList
          rows={byScope(harness.skills).map((skill) => (
            <SkillRow key={skill.path} skill={skill} {...props} />
          ))}
        />
      </SettingsSection>
    );
  }
  return harness.support.status ? (
    <LiveServers title={title} notes={notes} {...props} />
  ) : (
    <SettingsSection title={title} {...(notes ? { description: notes } : {})}>
      <ServerList statuses={undefined} {...props} />
    </SettingsSection>
  );
}

/** A harness's servers with their connection, which it reports once it has started each. */
function LiveServers({ title, notes, ...props }: SectionProps & { title: ReactNode; notes: string }) {
  const key = hubStatusKey(props.harness.provider, props.project);
  const result = useAtomValue(hubStatusAtom(key));
  const refreshStatus = useAtomRefresh(hubStatusAtom(key));
  const statuses = AsyncResult.getOrElse(result, (): ReadonlyArray<HubServerStatus> | undefined => undefined);
  const checking = result.waiting;
  return (
    <SettingsSection
      title={title}
      {...(notes ? { description: notes } : {})}
      action={
        checking ? (
          <span className="shrink-0 text-meta text-fg-tertiary">Connecting…</span>
        ) : AsyncResult.isFailure(result) ? (
          <span className="shrink-0 text-meta text-fg-tertiary" title={messageOf(result.cause)}>
            No status
          </span>
        ) : null
      }
    >
      <ServerList
        {...props}
        statuses={statuses}
        onChanged={() => {
          props.onChanged();
          refreshStatus();
        }}
      />
    </SettingsSection>
  );
}

function ServerList({
  statuses,
  ...props
}: SectionProps & { statuses: ReadonlyArray<HubServerStatus> | undefined }) {
  return (
    <FoldedList
      rows={byScope(props.harness.servers).map((server) => (
        <ServerRow
          key={`${server.scope}:${server.name}`}
          server={server}
          status={statuses?.find((each) => each.name === server.name)}
          live={statuses !== undefined}
          {...props}
        />
      ))}
    />
  );
}

/** How many rows a long list shows before the rest are asked for. */
const FOLD_AFTER = 5;

/** A card of rows that shows the first few of a long list, and the rest on request. */
function FoldedList({ rows }: { rows: ReadonlyArray<ReactNode> }) {
  const [all, setAll] = useState(false);
  // One more row than the fold would hide is shown instead: "Show 1 more" saves no room.
  const folded = !all && rows.length > FOLD_AFTER + 1;
  return (
    <SettingsCard className="flex flex-col divide-y divide-line-subtle">
      {folded ? rows.slice(0, FOLD_AFTER) : rows}
      {folded ? (
        <Button
          onClick={() => setAll(true)}
          className="flex h-9 items-center px-4 pl-9 text-left text-meta text-fg-tertiary transition-colors hover:text-fg-primary"
        >
          Show {rows.length - FOLD_AFTER} more
        </Button>
      ) : null}
    </SettingsCard>
  );
}

/**
 * A change the row shows at once while it saves: kept until the harness's config is read again, when
 * the row has a new `of` and shows what the file now says.
 */
interface Saving<T> {
  readonly of: T;
  readonly value: boolean;
}

/** A dot for a server's connection; none while it's simply connected or turned off. */
function Connection({ status }: { status: HubServerStatus | undefined }) {
  if (status === undefined || status.connection === "disabled") return null;
  const look = {
    connected: { dot: "bg-success", label: undefined },
    starting: { dot: "bg-running", label: "Starting" },
    failed: { dot: "bg-error", label: "Failed" },
    needsAuth: { dot: "bg-attention", label: "Needs sign-in" },
  }[status.connection];
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-meta text-fg-tertiary">
      <span className={`size-1.5 rounded-full ${look.dot}`} />
      {look.label === undefined ? <span className="sr-only">Connected</span> : look.label}
    </span>
  );
}

function ServerRow({
  server,
  status,
  live,
  harness,
  project,
  targets,
  onChanged,
}: SectionProps & { server: HubServer; status: HubServerStatus | undefined; live: boolean }) {
  const setServer = useAtomSet(setHubServer, { mode: "promise" });
  const [saving, setSaving] = useState<Saving<HubServer>>();
  const [error, setError] = useState<string>();
  const enabled = saving?.of === server ? saving.value : server.enabled;
  const ref = { provider: harness.provider, project, name: server.name, scope: server.scope };

  const toggle = (next: boolean) => {
    setError(undefined);
    setSaving({ of: server, value: next });
    setServer({ payload: { ...ref, enabled: next } }).then(onChanged, (failure: unknown) => {
      setSaving(undefined);
      setError(messageOf(failure));
    });
  };

  return (
    <HubRow
      name={server.name}
      meta={[
        scopeLabel[server.scope],
        transportLabel[server.transport],
        ...(server.disabledTools.length > 0
          ? [`${server.disabledTools.length} ${server.disabledTools.length === 1 ? "tool" : "tools"} off`]
          : []),
      ].join(" · ")}
      metaHint={scopeHint[server.scope]}
      off={!enabled}
      end={<Connection status={enabled ? status : undefined} />}
      control={
        harness.support.servers === "none"
          ? undefined
          : (labelledBy) => (
              <SettingsSwitch
                checked={enabled}
                onCheckedChange={toggle}
                disabled={lockedHere(harness, "servers")}
                labelledBy={labelledBy}
              />
            )
      }
      error={error}
    >
      <Details>
        {server.url !== undefined ? (
          <Detail label="URL">
            <Code>{server.url}</Code>
          </Detail>
        ) : server.command !== undefined ? (
          <Detail label="Runs">
            <Code>{[server.command, ...(server.args ?? [])].join(" ")}</Code>
          </Detail>
        ) : null}
        {server.env.length > 0 ? (
          <Detail label="Environment">
            <Secrets secrets={server.env} />
          </Detail>
        ) : null}
        {server.headers.length > 0 ? (
          <Detail label="Headers">
            <Secrets secrets={server.headers} />
          </Detail>
        ) : null}
        {server.file !== undefined ? (
          <Detail label="Config">
            <Code>{inProject(server.file, project)}</Code>
          </Detail>
        ) : null}
        {status?.error !== undefined ? (
          <Detail label="Error">
            <span className="text-error-text">{status.error}</span>
          </Detail>
        ) : null}
      </Details>
      <Tools
        server={server}
        status={status}
        live={live}
        harness={harness}
        project={project}
        onChanged={onChanged}
      />
      {server.scope === "bundled" || targets.length === 0 ? null : (
        <CopyTo
          what={server.name}
          from={server.scope}
          project={project}
          targets={targets}
          secrets={[...server.env, ...server.headers].length > 0}
          copy={(to) => ({ kind: "server", payload: { ...ref, to } })}
          onCopied={onChanged}
        />
      )}
    </HubRow>
  );
}

/**
 * A server's tools, from what its harness reports once connected, each with a switch where the harness
 * can turn one off; a tool already turned off is listed even when the server doesn't report it.
 */
function Tools({
  server,
  status,
  live,
  harness,
  project,
  onChanged,
}: {
  server: HubServer;
  status: HubServerStatus | undefined;
  live: boolean;
  harness: HubHarness;
  project: string;
  onChanged: () => void;
}) {
  const reported = status?.tools ?? [];
  const names = [
    ...reported.map((tool) => tool.name),
    ...server.disabledTools.filter((tool) => !reported.some((each) => each.name === tool)),
  ];
  if (names.length === 0) {
    if (!harness.support.status) return null;
    return (
      <p className="text-meta text-fg-tertiary">
        {!live
          ? "Tools show once it connects."
          : server.enabled
            ? "It reports no tools."
            : "Turn it on to see its tools."}
      </p>
    );
  }
  const switchable = harness.support.tools !== "none";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-meta font-medium text-fg-secondary">
        Tools <span className="font-normal text-fg-tertiary tabular-nums">{names.length}</span>
      </span>
      <div className="flex flex-col">
        {names.map((tool) => (
          <ToolLine
            key={tool}
            tool={tool}
            description={reported.find((each) => each.name === tool)?.description}
            server={server}
            harness={harness}
            project={project}
            switchable={switchable}
            onChanged={onChanged}
          />
        ))}
      </div>
    </div>
  );
}

function ToolLine({
  tool,
  description,
  server,
  harness,
  project,
  switchable,
  onChanged,
}: {
  tool: string;
  description: string | undefined;
  server: HubServer;
  harness: HubHarness;
  project: string;
  switchable: boolean;
  onChanged: () => void;
}) {
  const setTool = useAtomSet(setHubTool, { mode: "promise" });
  const [saving, setSaving] = useState<Saving<HubServer>>();
  const [error, setError] = useState<string>();
  const enabled = saving?.of === server ? saving.value : !server.disabledTools.includes(tool);
  const labelId = `tool-${server.scope}-${server.name}-${tool}`;

  const toggle = (next: boolean) => {
    setError(undefined);
    setSaving({ of: server, value: next });
    const payload = {
      provider: harness.provider,
      project,
      name: server.name,
      scope: server.scope,
      tool,
      enabled: next,
    };
    setTool({ payload }).then(onChanged, (failure: unknown) => {
      setSaving(undefined);
      setError(messageOf(failure));
    });
  };

  return (
    <div className="flex min-h-7 items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          id={labelId}
          title={description}
          className={`truncate font-mono text-caption ${enabled ? "text-fg-secondary" : "text-fg-tertiary line-through"}`}
        >
          {tool}
        </span>
        {error ? <span className="text-meta text-error-text">{error}</span> : null}
      </div>
      {switchable ? (
        <SettingsSwitch
          checked={enabled}
          onCheckedChange={toggle}
          disabled={lockedHere(harness, "tools")}
          labelledBy={labelId}
        />
      ) : null}
    </div>
  );
}

function SkillRow({ skill, harness, project, targets, onChanged }: SectionProps & { skill: HubSkill }) {
  const setSkill = useAtomSet(setHubSkill, { mode: "promise" });
  const [saving, setSaving] = useState<Saving<HubSkill>>();
  const [error, setError] = useState<string>();
  const enabled = saving?.of === skill ? saving.value : skill.enabled;

  const toggle = (next: boolean) => {
    setError(undefined);
    setSaving({ of: skill, value: next });
    setSkill({ payload: { provider: harness.provider, project, path: skill.path, enabled: next } }).then(
      onChanged,
      (failure: unknown) => {
        setSaving(undefined);
        setError(messageOf(failure));
      },
    );
  };

  return (
    <HubRow
      name={skill.name}
      meta={scopeLabel[skill.scope]}
      metaHint={scopeHint[skill.scope]}
      off={!enabled}
      control={
        harness.support.skills === "none"
          ? undefined
          : (labelledBy) => (
              <SettingsSwitch
                checked={enabled}
                onCheckedChange={toggle}
                disabled={lockedHere(harness, "skills")}
                labelledBy={labelledBy}
              />
            )
      }
      error={error}
    >
      {skill.description ? (
        <p className="text-meta leading-relaxed text-fg-secondary">{skill.description}</p>
      ) : null}
      <Details>
        <Detail label="Folder">
          <Code>{inProject(skill.path, project)}</Code>
        </Detail>
      </Details>
      {skill.scope === "bundled" || targets.length === 0 ? null : (
        <CopyTo
          what={skill.name}
          from={skill.scope}
          project={project}
          targets={targets}
          secrets={false}
          copy={(to) => ({
            kind: "skill",
            payload: { provider: harness.provider, project, path: skill.path, to },
          })}
          onCopied={onChanged}
        />
      )}
    </HubRow>
  );
}

/**
 * A server or skill: its name and where it's configured, its switch, and its details folded under it
 * until the name is clicked.
 */
function HubRow({
  name,
  meta,
  metaHint,
  off,
  end,
  control,
  error,
  children,
}: {
  name: string;
  meta: string;
  metaHint: string;
  off: boolean;
  end?: ReactNode;
  control: ((labelledBy: string) => ReactNode) | undefined;
  error: string | undefined;
  children: ReactNode;
}) {
  const labelId = `hub-${meta}-${name}`;
  return (
    <Collapsible.Root>
      <div className="flex min-h-11 items-center gap-3 py-1.5 pr-4 pl-2.5">
        <Collapsible.Trigger className="group flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-1 pl-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
          <ChevronRight
            size={13}
            strokeWidth={2}
            className="shrink-0 text-fg-tertiary transition-transform duration-200 ease-out-soft group-data-panel-open:rotate-90 motion-reduce:transition-none"
          />
          <span
            id={labelId}
            className={`min-w-0 truncate text-body ${off ? "text-fg-tertiary" : "text-fg-primary"}`}
          >
            {name}
          </span>
          <span className="shrink-0 text-meta text-fg-tertiary" title={metaHint}>
            {meta}
          </span>
        </Collapsible.Trigger>
        {end}
        {control?.(labelId)}
      </div>
      {error ? <p className="-mt-1 px-4 pb-2 pl-9 text-meta text-error-text">{error}</p> : null}
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
        <div className="flex flex-col gap-3 pr-4 pb-3.5 pl-9">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function Details({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-meta">{children}</dl>;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-tertiary">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Code({ children }: { children: string }) {
  return <span className="font-mono text-caption break-all text-fg-secondary">{children}</span>;
}

/** Environment variables or headers by name, each saying whether the config gives it a value. */
function Secrets({ secrets }: { secrets: ReadonlyArray<HubSecret> }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {secrets.map((secret) => (
        <span
          key={secret.name}
          className="flex items-center gap-1.5 rounded-md border border-line-subtle px-1.5 py-px"
        >
          <span className="font-mono text-caption text-fg-secondary">{secret.name}</span>
          <span className={`text-caption ${secret.set ? "text-fg-tertiary" : "text-attention-text"}`}>
            {secret.set ? "set" : "empty"}
          </span>
        </span>
      ))}
    </span>
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

/** A path inside the project from its folder, as `.cursor/mcp.json`; any other in full. */
const inProject = (path: string, project: string) => {
  const plain = (each: string) => each.replaceAll("\\", "/").replace(/\/+$/, "");
  const [file, folder] = [plain(path), plain(project)];
  return file.toLowerCase().startsWith(`${folder.toLowerCase()}/`) ? file.slice(folder.length + 1) : path;
};

/**
 * Copies a server or skill into other harnesses, each in its own format: the harnesses ticked, for this
 * project or every one; then where each copy went and what's left to fill in.
 */
function CopyTo({
  what,
  from,
  project,
  targets,
  secrets,
  copy,
  onCopied,
}: {
  what: string;
  from: HubScope;
  project: string;
  targets: ReadonlyArray<ProviderId>;
  secrets: boolean;
  copy: (to: ReadonlyArray<{ provider: ProviderId; scope: HubTargetScope }>) => CopyRequest;
  onCopied: () => void;
}) {
  const copyServer = useAtomSet(copyHubServer, { mode: "promise" });
  const copySkill = useAtomSet(copyHubSkill, { mode: "promise" });
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<ReadonlyArray<ProviderId>>([]);
  const [scope, setScope] = useState<HubTargetScope>(from === "user" ? "user" : "project");
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<ReadonlyArray<HubCopyOutcome>>();
  const [error, setError] = useState<string>();

  const start = () => {
    const request = copy(chosen.map((provider) => ({ provider, scope })));
    setBusy(true);
    setError(undefined);
    const sent =
      request.kind === "server"
        ? copyServer({ payload: request.payload })
        : copySkill({ payload: request.payload });
    sent.then(
      (done) => {
        setBusy(false);
        setOutcomes(done);
        onCopied();
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
          setOutcomes(undefined);
          setChosen([]);
          setError(undefined);
        }
      }}
    >
      <Popover.Trigger
        render={<Button />}
        className="flex h-7 items-center self-start rounded-md border border-line-subtle px-2.5 text-meta font-medium text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary data-popup-open:bg-surface-hover data-popup-open:text-fg-primary"
      >
        Copy to…
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} className="z-50 outline-none">
          <Popover.Popup
            aria-label={`Copy ${what}`}
            className="flex w-72 max-w-[calc(100vw-1rem)] origin-(--transform-origin) flex-col gap-3 rounded-xl border border-line-subtle bg-surface-overlay p-3.5 text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0"
          >
            {outcomes === undefined ? (
              <>
                <span className="truncate text-body font-medium">Copy {what} to</span>
                <div className="flex flex-col gap-2">
                  {targets.map((provider) => (
                    <DialogCheck
                      key={provider}
                      checked={chosen.includes(provider)}
                      onCheckedChange={(checked) =>
                        setChosen((current) =>
                          checked ? [...current, provider] : current.filter((each) => each !== provider),
                        )
                      }
                    >
                      <ProviderLogo provider={provider} size={14} />
                      {harnessName[provider]}
                    </DialogCheck>
                  ))}
                </div>
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
                    Secrets aren't copied: each copy names them for you to fill in.
                  </p>
                ) : null}
                {error ? <p className="text-meta text-error-text">{error}</p> : null}
                <div className="flex justify-end">
                  <RowButton tone="primary" onClick={start} disabled={busy || chosen.length === 0}>
                    {busy ? "Copying…" : "Copy"}
                  </RowButton>
                </div>
              </>
            ) : (
              <>
                <ul className="flex flex-col gap-2.5">
                  {outcomes.map((outcome) => (
                    <li key={outcome.provider} className="flex items-start gap-2">
                      <span className="flex h-4 shrink-0 items-center">
                        <ProviderLogo provider={outcome.provider} size={14} />
                      </span>
                      <div className="flex min-w-0 flex-col gap-0.5 text-meta">
                        <span className="font-medium">{harnessName[outcome.provider]}</span>
                        {outcome.skipped !== undefined ? (
                          <span className="text-fg-tertiary">{outcome.skipped}</span>
                        ) : (
                          <>
                            <span className="text-fg-tertiary">
                              Added to{" "}
                              <span className="font-mono text-caption break-all" title={outcome.wrote}>
                                {outcome.wrote === undefined ? "" : inProject(outcome.wrote, project)}
                              </span>
                            </span>
                            {outcome.fill.length > 0 ? (
                              <span className="text-attention-text">
                                Fill in {outcome.fill.join(", ")} there.
                              </span>
                            ) : null}
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
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
