import { Button } from "@base-ui/react/button";
import { defaultSettings } from "@cerium/protocol";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Route, Users } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  effortRouterStatusAtom,
  removeEffortRouterKey,
  saveEffortRouterKey,
  settingsAtom,
} from "../../backend/atoms.ts";
import { machineAtom } from "../../backend/machine.ts";
import { WEB } from "../../backend/target.ts";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { messageOf } from "../terminal/model.ts";
import {
  SettingsCard,
  SettingsList,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  SettingsTag,
} from "./parts.tsx";
import { RowButton } from "./ToolRow.tsx";
import { useSetting } from "./useSetting.ts";

/** A decision costs a few thousandths of a cent, so small sums keep two significant digits. */
const spent = (usd: number): string =>
  usd === 0 ? "$0" : usd < 0.01 ? `$${Number(usd.toPrecision(2))}` : `$${usd.toFixed(2)}`;

const childrenLabel = { router: "Auto", lead: "Lead's level" } as const;

/**
 * The experimental effort router: a decision model, through the user's own OpenRouter
 * key, picks the reasoning effort of agents on Auto before each turn. The key is typed only into the
 * desktop app of the computer whose agents use it; another device sees that there is one, and can
 * remove it.
 */
export function EffortRouterSettings() {
  const status = useAtomValue(effortRouterStatusAtom);
  const refreshStatus = useAtomRefresh(effortRouterStatusAtom);
  const refreshSettings = useAtomRefresh(settingsAtom);
  const save = useAtomSet(saveEffortRouterKey, { mode: "promise" });
  const remove = useAtomSet(removeEffortRouterKey, { mode: "promise" });
  const machine = useAtomValue(machineAtom);
  const {
    value: router,
    saved,
    save: saveRouter,
    error: routerError,
  } = useSetting("effortRouter", defaultSettings.effortRouter);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyError, setKeyError] = useState<string>();

  const monthEndsAt = AsyncResult.isSuccess(status) ? status.value.monthEndsAt : undefined;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          refreshStatus();
          schedule();
        },
        Math.min(60_000, Math.max(1000, (monthEndsAt ?? Infinity) - Date.now() + 50)),
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [refreshStatus, monthEndsAt]);

  // A machine too old for the router has nothing to show.
  if (AsyncResult.isFailure(status)) {
    return (
      <EffortRouterPage>
        <SettingsNote>Update Cerium on that computer to use the effort router.</SettingsNote>
      </EffortRouterPage>
    );
  }
  const known = AsyncResult.isSuccess(status) ? status.value : undefined;
  const key = known?.key;
  const local = !WEB && machine === undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim() === "" || busy) return;
    setBusy(true);
    setKeyError(undefined);
    save({ payload: { key: draft.trim() } }).then(
      () => {
        setDraft("");
        setBusy(false);
        refreshStatus();
      },
      (failure: unknown) => {
        setBusy(false);
        setKeyError(messageOf(failure));
      },
    );
  };
  const forget = () => {
    setBusy(true);
    setKeyError(undefined);
    remove({ payload: undefined }).then(
      () => {
        setBusy(false);
        refreshStatus();
        refreshSettings();
      },
      (failure: unknown) => {
        setBusy(false);
        setKeyError(messageOf(failure));
      },
    );
  };

  return (
    <EffortRouterPage>
      <SettingsList>
        <SettingsRow
          label="Pick effort automatically"
          hint={key === undefined && !router.enabled ? "Needs an OpenRouter key" : undefined}
          error={routerError}
          control={(labelledBy) => (
            <SettingsSwitch
              checked={router.enabled}
              onCheckedChange={(on) => saveRouter({ ...router, enabled: on })}
              disabled={saved === undefined || (key === undefined && !router.enabled)}
              labelledBy={labelledBy}
            />
          )}
        />
        {router.enabled ? (
          <SettingsRow
            label="Agents a lead starts"
            hint="When the lead names no effort for them"
            className="pr-2.5"
            control={() => (
              <SelectRoot
                value={router.children}
                onValueChange={(next) => next !== null && saveRouter({ ...router, children: next })}
              >
                <SelectTrigger label="Effort of agents a lead starts">
                  {childrenLabel[router.children]}
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="router" icon={Route} description="The router picks their effort too">
                    {childrenLabel.router}
                  </SelectItem>
                  <SelectItem value="lead" icon={Users} description="They run at the lead's current level">
                    {childrenLabel.lead}
                  </SelectItem>
                </SelectPopup>
              </SelectRoot>
            )}
          />
        ) : null}
        <SettingsRow
          label="OpenRouter key"
          hint={
            key
              ? undefined
              : local
                ? "Kept encrypted on this computer and sent only to OpenRouter."
                : `Add it in the Cerium app on ${machine?.name ?? "that computer"}.`
          }
          error={keyError}
          control={() =>
            key ? (
              <span className="flex shrink-0 items-center gap-3">
                <span className="font-mono text-meta text-fg-tertiary">•••• {key.last4}</span>
                <RowButton onClick={forget}>Remove</RowButton>
              </span>
            ) : local ? (
              <form onSubmit={submit} className="flex shrink-0 items-center gap-2">
                <input
                  type="password"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="sk-or-…"
                  aria-label="OpenRouter key"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={busy || known === undefined}
                  className="h-7 w-44 min-w-0 rounded-md border border-line-strong bg-transparent px-2 text-meta text-fg-primary outline-none placeholder:text-fg-tertiary focus-visible:border-fg-tertiary disabled:opacity-60 max-md:w-32"
                />
                <Button
                  type="submit"
                  disabled={busy || draft.trim() === ""}
                  className="flex h-7 items-center rounded-md bg-accent px-3 text-meta font-medium text-accent-fg transition-colors hover:bg-accent-strong disabled:opacity-50"
                >
                  {busy ? "Checking…" : "Save"}
                </Button>
              </form>
            ) : null
          }
        />
      </SettingsList>
      <SettingsSection title="This month" description="At this month's usage rate. Both reset each month.">
        <SettingsCard>
          <dl className="grid grid-cols-2 gap-4 px-4 py-3.5">
            <div>
              <dt className="text-meta text-fg-tertiary">Spent</dt>
              <dd className="mt-0.5 text-reading tabular-nums text-fg-primary">
                {known ? spent(known.monthUsd) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-meta text-fg-tertiary">Estimated by month end</dt>
              <dd className="mt-0.5 text-reading tabular-nums text-fg-primary">
                {known?.projectedMonthUsd === undefined ? "—" : spent(known.projectedMonthUsd)}
              </dd>
            </div>
          </dl>
        </SettingsCard>
      </SettingsSection>
    </EffortRouterPage>
  );
}

function EffortRouterPage({ children }: { children: ReactNode }) {
  return (
    <SettingsPage
      perMachine
      title={
        <>
          Effort router
          <SettingsTag>Experimental</SettingsTag>
        </>
      }
      description="Before each turn of an agent on Auto, a decision model picks its reasoning effort, through your own OpenRouter key."
    >
      {children}
    </SettingsPage>
  );
}
