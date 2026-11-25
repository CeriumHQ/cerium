import { Button } from "@base-ui/react/button";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { HubHarness, HubServerStatus, ProjectInfo, ProviderId } from "@cerium/protocol";
import { HUB_INSTRUCTIONS_RPC_VERSION } from "@cerium/rpc";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { RefreshCw } from "lucide-react";
import { use, useState, type ReactNode } from "react";

import { hubAtom, hubStatusesAtom } from "../../backend/hub.ts";
import { savedProjectsAtom } from "../../backend/projects.ts";
import { drivenRpcVersionAtom } from "../../backend/atoms.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { SearchBar } from "../../components/ui/SearchBar.tsx";
import { harnessName } from "./Harnesses.tsx";
import type { HarnessIndicator } from "../threads/Sidebar.tsx";
import { HubInstructions } from "./HubInstructions.tsx";
import { readyProviders } from "./ModelGroups.tsx";
import { filterHub, groupHub, type HubGroup, type HubPlace } from "./hubModel.ts";
import { messageOf, type HubContext, type Kind, type Live } from "./hubRows.tsx";
import { ServerGroupRow } from "./HubServers.tsx";
import { SkillGroupRow } from "./HubSkills.tsx";
import { SettingsCard, SettingsNote, SettingsPage, SettingsProject } from "./parts.tsx";
import { initialProject } from "./scriptsModel.ts";
import { ProjectSelect } from "./SourceControl.tsx";

// Settings → MCP servers and Settings → Skills: every harness's servers or skills for one project, each
// listed once with the harnesses that have it, as their own configs say. A row opens onto each harness's
// copy with its switch, a server's tools across harnesses, and a way to add it to the harnesses without
// it. Switches show only where the harness itself can turn the thing off; where it can't, the row says so.

const pageCopy: Record<Kind, { title: string; description: string; empty: string; search: string }> = {
  servers: {
    title: "MCP servers",
    description:
      "Each enabled harness's servers for a project, edited in its own config. Secrets stay there: only whether one is set shows.",
    empty: "No enabled harness has an MCP server for this project.",
    search: "Search servers",
  },
  skills: {
    title: "Skills",
    description: "Each enabled harness's skills for a project, read from its own folders.",
    empty: "No enabled harness has a skill for this project.",
    search: "Search skills",
  },
};

const placeTitle: Record<HubPlace, string> = {
  project: "This project",
  user: "All projects",
  bundled: "Built-in",
};

interface HubPageProps {
  readonly harnesses: ReadonlyArray<HarnessIndicator>;
  readonly onOpen?: () => void;
}

export const McpSettings = (props: HubPageProps) => <HubSettings kind="servers" {...props} />;
export const SkillsSettings = (props: HubPageProps) => <HubSettings kind="skills" {...props} />;
export const InstructionSettings = (props: HubPageProps) => <HubSettings kind="instructions" {...props} />;

function HubSettings({ kind, harnesses, onOpen }: HubPageProps & { kind: Kind | "instructions" }) {
  const listed = useAtomValue(savedProjectsAtom);
  const rpcVersion = useAtomValue(drivenRpcVersionAtom);
  const from = use(SettingsProject);
  const [picked, setPicked] = useState<string>();
  const projects = AsyncResult.getOrElse(listed, (): ReadonlyArray<ProjectInfo> => []).filter(
    (project) => project.missing !== true,
  );
  const paths = projects.map((project) => project.path);
  const shown = picked !== undefined && paths.includes(picked) ? picked : initialProject(paths, from);
  if (kind === "instructions") {
    const supported = rpcVersion >= HUB_INSTRUCTIONS_RPC_VERSION;
    return (
      <SettingsPage
        perMachine
        title="Project instructions"
        description="One canonical file for a project's instructions, synced to each enabled harness's own file."
        action={
          shown === undefined || !supported ? null : (
            <ProjectSelect projects={paths} shown={shown} onPick={setPicked} />
          )
        }
      >
        {!supported ? (
          <SettingsNote>Update Cerium on this machine to manage project instructions.</SettingsNote>
        ) : shown === undefined ? (
          <SettingsNote>
            No projects yet. Open a folder in a new thread to manage its instructions.
          </SettingsNote>
        ) : (
          <HubInstructions key={shown} project={shown} harnesses={harnesses} />
        )}
      </SettingsPage>
    );
  }
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
        <HubBody
          key={shown}
          project={shown}
          kind={kind}
          harnesses={harnesses}
          {...(onOpen ? { onOpen } : {})}
        />
      )}
    </SettingsPage>
  );
}

/** Reads every harness's config again, for a change made outside Cerium. */
function RefreshHub({ project }: { project: string }) {
  const refresh = useAtomRefresh(hubAtom(project));
  return <IconButton icon={RefreshCw} label="Read again" onClick={refresh} />;
}

/** The search and harness filter, and the list under its places. */
function HubBody({
  project,
  kind,
  harnesses: indicators,
  onOpen,
}: {
  project: string;
  kind: Kind;
  harnesses: ReadonlyArray<HarnessIndicator>;
  onOpen?: () => void;
}) {
  const result = useAtomValue(hubAtom(project));
  const refresh = useAtomRefresh(hubAtom(project));
  const reports = useAtomValue(hubStatusesAtom(project));
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<ProviderId>();
  const checking = indicators.every((harness) => harness.state === "unsupported");
  const ready = readyProviders(indicators);
  const harnesses = AsyncResult.getOrElse(result, (): ReadonlyArray<HubHarness> | undefined => undefined);
  if (checking || harnesses === undefined) {
    return AsyncResult.isFailure(result) && harnesses === undefined ? (
      <SettingsNote tone="error">{messageOf(result.cause)}</SettingsNote>
    ) : (
      <SettingsNote>Reading each harness's config…</SettingsNote>
    );
  }
  if (ready.size === 0) {
    return (
      <SettingsNote>
        No harnesses are enabled.{" "}
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="text-fg-secondary underline-offset-2 hover:underline"
          >
            Manage harnesses
          </button>
        ) : null}
      </SettingsNote>
    );
  }
  const readable = harnesses.filter(
    (harness) => harness.unavailable === undefined && ready.has(harness.provider),
  );
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
          <div className="overflow-hidden rounded-lg border border-line-subtle bg-surface-sunken">
            <SearchBar flush value={query} onChange={setQuery} placeholder={pageCopy[kind].search} />
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
