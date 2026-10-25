import { Button } from "@base-ui/react/button";
import {
  rosterMembers,
  rosterUse,
  starterRoster,
  withHarnessReset,
  withHarnessRoster,
  type ModelInfo,
  type ProviderId,
  type RosterModel,
  type RosterSettings,
} from "@cerium/protocol";
import { MoreHorizontal, Plus, RotateCcw, X } from "lucide-react";
import { useRef, useState } from "react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { MenuItem, MenuPopup, MenuRoot, MenuTrigger } from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { TitleField } from "../threads/Rename.tsx";
import { providerName } from "../threads/model.ts";
import type { HarnessIndicator } from "../threads/Sidebar.tsx";
import { readyProviders } from "./ModelGroups.tsx";
import { SettingsCard, SettingsSection } from "./parts.tsx";
import { useSetting } from "./useSetting.ts";

/** How long a model's line may be: a phrase for the lead to pick by, not instructions. */
const MAX_USE = 160;

const emptyRoster: RosterSettings = { models: [], edited: [] };

/**
 * The roster: for each harness that can run, the models a lead starts without asking, each with what
 * it's for. Models join from the harness's Add menu and leave from their row; a line is edited in
 * place. Saved by the backend, which hands it to leads as `list_models`.
 */
export function RosterSection({
  models,
  harnesses,
}: {
  models: ReadonlyArray<ModelInfo>;
  harnesses: ReadonlyArray<HarnessIndicator>;
}) {
  const { value: roster, saved, save, error } = useSetting("roster", emptyRoster);
  const ready = readyProviders(harnesses);
  const offered = models.filter((model) => ready.has(model.provider));
  const members = rosterMembers(roster, offered);
  const providers = harnesses.flatMap(({ provider }) =>
    offered.some((model) => model.provider === provider) ? [provider] : [],
  );
  if (providers.length === 0) return null;

  /** The harness's list as it stands, ready to change: the user's own, or Cerium's picks. */
  const listOf = (provider: ProviderId): ReadonlyArray<RosterModel> =>
    roster.edited.includes(provider)
      ? roster.models.filter((entry) => entry.provider === provider)
      : starterRoster(provider, offered);
  const change = (provider: ProviderId, next: ReadonlyArray<RosterModel>) =>
    save(withHarnessRoster(roster, provider, next));

  return (
    <SettingsSection
      title="Roster"
      description={
        <>
          The models a lead starts without asking you, and what it uses each for. It asks before starting any
          other.
          {error ? <span className="block text-error">{error}</span> : null}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {providers.map((provider) => {
          const list = listOf(provider);
          return (
            <HarnessRoster
              key={provider}
              provider={provider}
              offered={offered.filter((model) => model.provider === provider)}
              members={members.filter((member) => member.model.provider === provider)}
              edited={roster.edited.includes(provider)}
              disabled={saved === undefined}
              onAdd={(model) => change(provider, [...list, { provider, model: model.id }])}
              onRemove={(model) =>
                change(
                  provider,
                  list.filter((entry) => entry.model !== model.id),
                )
              }
              onDescribe={(model, use) =>
                change(
                  provider,
                  list.map((entry) => {
                    if (entry.model !== model.id) return entry;
                    const { use: _, ...rest } = entry;
                    return use === undefined ? rest : { ...rest, use };
                  }),
                )
              }
              onReset={() => save(withHarnessReset(roster, provider))}
            />
          );
        })}
      </div>
    </SettingsSection>
  );
}

/** One harness's card: its name and Add menu over a row per model on the roster. */
function HarnessRoster({
  provider,
  offered,
  members,
  edited,
  disabled,
  onAdd,
  onRemove,
  onDescribe,
  onReset,
}: {
  provider: ProviderId;
  offered: ReadonlyArray<ModelInfo>;
  members: ReadonlyArray<{ readonly model: ModelInfo; readonly use: string }>;
  edited: boolean;
  disabled: boolean;
  onAdd: (model: ModelInfo) => void;
  onRemove: (model: ModelInfo) => void;
  /** The user's own line, or undefined for Cerium's. */
  onDescribe: (model: ModelInfo, use: string | undefined) => void;
  onReset: () => void;
}) {
  const others = offered.filter((model) => !members.some((member) => member.model.id === model.id));
  const name = providerName[provider];
  return (
    <SettingsCard className="flex flex-col divide-y divide-line-subtle">
      <div className="flex h-11 items-center gap-2 pr-2.5 pl-4">
        <ProviderLogo provider={provider} size={14} />
        <span className="text-body font-medium text-fg-primary">{name}</span>
        <span className="text-meta text-fg-tertiary tabular-nums">
          {members.length} of {offered.length}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          {others.length > 0 ? (
            <MenuRoot>
              <MenuTrigger>
                <Button
                  disabled={disabled}
                  className="flex h-7 items-center gap-1 rounded-md px-2 text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary data-disabled:opacity-40 data-popup-open:bg-surface-hover"
                >
                  <Plus size={13} strokeWidth={1.75} />
                  Add
                </Button>
              </MenuTrigger>
              <MenuPopup>
                {others.map((model) => (
                  <MenuItem key={model.id} onClick={() => onAdd(model)}>
                    {model.label}
                  </MenuItem>
                ))}
              </MenuPopup>
            </MenuRoot>
          ) : null}
          {edited ? (
            <MenuRoot>
              <MenuTrigger>
                <Button
                  aria-label={`More for ${name}`}
                  disabled={disabled}
                  className="grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary data-disabled:opacity-40 data-popup-open:bg-surface-hover"
                >
                  <MoreHorizontal size={15} strokeWidth={1.75} />
                </Button>
              </MenuTrigger>
              <MenuPopup>
                <MenuItem icon={RotateCcw} onClick={onReset}>
                  Reset to Cerium's picks
                </MenuItem>
              </MenuPopup>
            </MenuRoot>
          ) : null}
        </span>
      </div>
      {members.length === 0 ? (
        <p className="px-4 py-3 text-meta text-fg-tertiary">
          None. A lead asks before starting any {name} model.
        </p>
      ) : (
        members.map(({ model, use }) => (
          <RosterRow
            key={model.id}
            model={model}
            use={use}
            disabled={disabled}
            onRemove={() => onRemove(model)}
            onDescribe={(next) => onDescribe(model, next)}
          />
        ))
      )}
    </SettingsCard>
  );
}

/**
 * A model on the roster: its name over what it's for, a line to click and rewrite, and a button that
 * takes it off. A line cleared, or put back to Cerium's own, stops being the user's.
 */
function RosterRow({
  model,
  use,
  disabled,
  onRemove,
  onDescribe,
}: {
  model: ModelInfo;
  use: string;
  disabled: boolean;
  onRemove: () => void;
  onDescribe: (use: string | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const line = useRef<HTMLButtonElement>(null);
  const fallback = rosterUse(model);
  const own = use !== fallback;

  const finish = (typed: string | undefined, byKey: boolean) => {
    setEditing(false);
    if (byKey) requestAnimationFrame(() => line.current?.focus());
    if (typed === undefined) return;
    const next = typed.trim();
    const kept = next === "" || next === fallback ? undefined : next;
    if (kept !== (own ? use : undefined)) onDescribe(kept);
  };

  return (
    <div className="group/row flex min-h-12 items-center gap-3 py-2 pr-2.5 pl-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-medium text-fg-primary">{model.label}</span>
        {editing ? (
          <TitleField
            title={use}
            label={`What ${model.label} is for`}
            maxLength={MAX_USE}
            onDone={finish}
            className="-mx-1 text-meta leading-relaxed"
          />
        ) : (
          <Tooltip label="Describe what it's for">
            <Button
              ref={line}
              disabled={disabled}
              onClick={() => setEditing(true)}
              className={`-mx-1 max-w-full cursor-text self-start truncate rounded-sm px-1 text-left text-meta leading-relaxed transition-colors outline-none hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-focus-ring ${
                own ? "text-fg-secondary" : "text-fg-tertiary"
              }`}
            >
              {use}
            </Button>
          </Tooltip>
        )}
      </div>
      <Tooltip label="Take off the roster">
        <Button
          aria-label={`Take ${model.label} off the roster`}
          disabled={disabled}
          onClick={onRemove}
          className="grid size-7 shrink-0 place-items-center rounded-md text-fg-tertiary opacity-0 transition-[opacity,color,background-color] group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-surface-hover hover:text-fg-primary focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <X size={14} strokeWidth={1.75} />
        </Button>
      </Tooltip>
    </div>
  );
}
