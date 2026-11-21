import { Button } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type {
  HubCopyOutcome,
  HubScope,
  HubServer,
  HubSkill,
  HubTargetScope,
  ProviderId,
} from "@cerium/protocol";
import { useAtomSet } from "@effect/atom-react";
import { Plus } from "lucide-react";
import { useState } from "react";

import { copyHubServer, copyHubSkill } from "../../backend/hub.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { segmentedTrackClass } from "../../components/ui/Segmented.tsx";
import { harnessName } from "./Harnesses.tsx";
import type { HubGroup } from "./hubModel.ts";
import { inProject, messageOf, type HubContext, type Kind } from "./hubRows.tsx";
import { RowButton } from "./ToolRow.tsx";

/** A button for each harness that could have the server or skill and doesn't, which copies it there. */
export function AddTo<T extends HubServer | HubSkill>({
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
        className="flex h-7 items-center gap-1.5 rounded-full border border-dashed border-line-strong pr-2.5 pl-2 text-meta text-fg-secondary transition-colors hover:border-solid hover:bg-surface-hover hover:text-fg-primary data-popup-open:border-solid data-popup-open:bg-surface-active data-popup-open:text-fg-primary"
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
                  className={`${segmentedTrackClass} self-start`}
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
