import { Collapsible } from "@base-ui/react/collapsible";
import type { HubHarness, HubScope, HubServerStatus, ProviderId } from "@cerium/protocol";
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { harnessName } from "./Harnesses.tsx";
import { SettingsSwitch } from "./parts.tsx";

// The pieces every row of Settings → MCP servers and Settings → Skills is made of (Hub.tsx): a row
// that opens onto each harness's copy, the copy's line and switch, and the switch's saving state.

export type Kind = "servers" | "skills";

export const messageOf = (error: unknown) =>
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

/** A harness's live report on its servers, once it has started each. */
export interface Live {
  readonly statuses: ReadonlyArray<HubServerStatus> | undefined;
  readonly waiting: boolean;
  readonly failed: string | undefined;
}

/** What every row of a page needs from it. */
export interface HubContext {
  readonly project: string;
  /** The harnesses whose config could be read, which a server or skill can be added to. */
  readonly harnesses: ReadonlyArray<HubHarness>;
  readonly live: ReadonlyMap<ProviderId, Live>;
  /** The harness the list is narrowed to, whose switch each row then shows without opening. */
  readonly picked: ProviderId | undefined;
  readonly onChanged: () => void;
}

/**
 * A server or skill: its name and a line on it, the harnesses that have it, and their copies folded
 * under it until it's opened. With the list narrowed to one harness, that harness's switch sits on the row.
 */
export function GroupRow({
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
export interface Mark {
  readonly provider: ProviderId;
  readonly on: boolean;
  readonly dot: string | undefined;
  readonly label: string;
}

/** The harnesses that have a server or skill, once each however many scopes it sits in there. */
export function Presence({ marks }: { marks: ReadonlyArray<Mark> }) {
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
export function Part({ label, end, children }: { label: string; end?: ReactNode; children: ReactNode }) {
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
export function Copies({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle bg-surface-sunken">
      {children}
    </div>
  );
}

/** One harness's copy: the harness, where it's configured, its state and its switch. */
export function CopyLine({
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
export function useSaving<T>(
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
export const limitOf = (harness: HubHarness, kind: "servers" | "tools" | "skills"): string | undefined => {
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
export const lockedHere = (harness: HubHarness, kind: "servers" | "tools" | "skills") =>
  harness.locked !== undefined && harness.support[kind] === "project";

/** A copy's switch, or why there's none: held off for now, or not something the harness can turn off. */
export function CopySwitch({
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
export const inProject = (path: string, project: string) => {
  const plain = (each: string) => each.replaceAll("\\", "/").replace(/\/+$/, "");
  const [file, folder] = [plain(path), plain(project)];
  return file.toLowerCase().startsWith(`${folder.toLowerCase()}/`) ? file.slice(folder.length + 1) : path;
};
