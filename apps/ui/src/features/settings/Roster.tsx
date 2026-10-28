import { Button } from "@base-ui/react/button";
import {
  movedInOrder,
  rosterMembers,
  rosterUse,
  starterRoster,
  withHarnessReset,
  withHarnessRoster,
  type ModelInfo,
  type ModelSpeed,
  type ProviderId,
  type RosterMember,
  type RosterModel,
  type RosterSettings,
} from "@cerium/protocol";
import { ChevronDown, ChevronUp, GripVertical, MoreHorizontal, Plus, RotateCcw, X } from "lucide-react";
import { useRef, useState, type DragEvent, type ReactNode } from "react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { MenuItem, MenuPopup, MenuRoot, MenuTrigger } from "../../components/ui/Menu.tsx";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { speedHint, speedLabel } from "../composer/models.ts";
import { SpeedMark } from "../composer/Pickers.tsx";
import { TitleField } from "../threads/Rename.tsx";
import { providerName } from "../threads/model.ts";
import type { HarnessIndicator } from "../threads/Sidebar.tsx";
import { readyProviders } from "./ModelGroups.tsx";
import { SettingsCard } from "./parts.tsx";
import { useSetting } from "./useSetting.ts";

/** How long a model's line may be: a phrase for the lead to pick by, not instructions. */
const MAX_USE = 160;

const emptyRoster: RosterSettings = { models: [], edited: [] };

/**
 * The roster: for each harness that can run, the models a lead starts without asking, in the order it
 * prefers them, each with what it's for and the speed it runs at. Models join from the harness's Add
 * menu, leave from their row and move by their handle; a line is edited in place. Saved by the
 * backend, which hands it to leads as `list_models`.
 */
export function RosterSection({
  models,
  harnesses,
  empty,
}: {
  models: ReadonlyArray<ModelInfo>;
  harnesses: ReadonlyArray<HarnessIndicator>;
  /** Shown while no harness that can run offers a model. */
  empty: ReactNode;
}) {
  const { value: roster, saved, save, error } = useSetting("roster", emptyRoster);
  const ready = readyProviders(harnesses);
  const offered = models.filter((model) => ready.has(model.provider));
  const members = rosterMembers(roster, offered);
  const providers = harnesses.flatMap(({ provider }) =>
    offered.some((model) => model.provider === provider) ? [provider] : [],
  );
  if (providers.length === 0) return empty;

  /** The harness's list as it stands, ready to change: the user's own, or Cerium's picks. */
  const listOf = (provider: ProviderId): ReadonlyArray<RosterModel> =>
    roster.edited.includes(provider)
      ? roster.models.filter((entry) => entry.provider === provider)
      : starterRoster(provider, offered);
  const change = (provider: ProviderId, next: ReadonlyArray<RosterModel>) =>
    save(withHarnessRoster(roster, provider, next));

  return (
    <>
      {error ? <p className="-mt-4 text-meta text-error-text">{error}</p> : null}
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
              onSpeed={(model, speed) =>
                change(
                  provider,
                  list.map((entry) => {
                    if (entry.model !== model.id) return entry;
                    const { speed: _, ...rest } = entry;
                    return speed === undefined ? rest : { ...rest, speed };
                  }),
                )
              }
              // Models the harness no longer offers keep their entries, after the ones it ranks.
              onOrder={(order) =>
                change(provider, [
                  ...order.flatMap((model) => list.filter((entry) => entry.model === model)),
                  ...list.filter((entry) => !order.includes(entry.model)),
                ])
              }
              onReset={() => save(withHarnessReset(roster, provider))}
            />
          );
        })}
      </div>
    </>
  );
}

/** What a dragged row carries: nothing another drop target takes. */
const ROW_DRAG_TYPE = "application/x-cerium-roster-model";

/**
 * One harness's card: its name and Add menu over a row per model on the roster, first choice first. A
 * row moves by dragging its handle, the card showing where it lands, or by the arrow keys on it.
 */
function HarnessRoster({
  provider,
  offered,
  members,
  edited,
  disabled,
  onAdd,
  onRemove,
  onDescribe,
  onSpeed,
  onOrder,
  onReset,
}: {
  provider: ProviderId;
  offered: ReadonlyArray<ModelInfo>;
  members: ReadonlyArray<RosterMember>;
  edited: boolean;
  disabled: boolean;
  onAdd: (model: ModelInfo) => void;
  onRemove: (model: ModelInfo) => void;
  /** The user's own line, or undefined for Cerium's. */
  onDescribe: (model: ModelInfo, use: string | undefined) => void;
  /** The speed picked, or undefined for the harness's own. */
  onSpeed: (model: ModelInfo, speed: ModelSpeed | undefined) => void;
  /** The models' ids in their new order of priority. */
  onOrder: (order: ReadonlyArray<string>) => void;
  onReset: () => void;
}) {
  /** The row being dragged and the order it would land in, saved on the drop. */
  const [drag, setDrag] = useState<{ readonly model: string; readonly order: ReadonlyArray<string> }>();
  const others = offered.filter((model) => !members.some((member) => member.model.id === model.id));
  const name = providerName[provider];
  const order = members.map((member) => member.model.id);
  const shown =
    drag === undefined
      ? members
      : drag.order.flatMap((id) => members.filter((member) => member.model.id === id));

  /**
   * A step up or down, by the arrow keys on the handle or the buttons beside it; what was used keeps
   * focus as its row moves, a button that has run out of room handing it to the other one.
   */
  const step = (model: string, by: -1 | 1, from: "handle" | "button") => {
    const target = order[order.indexOf(model) + by];
    if (target === undefined) return;
    onOrder(movedInOrder(order, model, target));
    requestAnimationFrame(() => {
      const key = `${provider}/${model}`;
      const find = (attribute: string, value: string) =>
        document.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(value)}"]:not([data-disabled])`);
      const next =
        from === "button"
          ? (find("data-roster-move", `${key}:${by}`) ?? find("data-roster-move", `${key}:${-by}`))
          : find("data-roster-handle", key);
      next?.focus();
    });
  };

  // Only this card's own drag is taken: it alone sets `drag`.
  const dragProps = (model: string) => ({
    onDragEnter: () => {
      if (drag === undefined || model === drag.model) return;
      setDrag({ ...drag, order: movedInOrder(drag.order, drag.model, model) });
    },
    onDragOver: (event: DragEvent) => {
      if (drag === undefined) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onDrop: (event: DragEvent) => {
      if (drag === undefined) return;
      event.preventDefault();
      if (drag.order.some((id, at) => id !== order[at])) onOrder(drag.order);
      setDrag(undefined);
    },
  });

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
        shown.map(({ model, use, speed }, at) => (
          <RosterRow
            key={model.id}
            provider={provider}
            model={model}
            use={use}
            speed={speed}
            rank={members.length > 1 ? at + 1 : undefined}
            count={members.length}
            dragging={drag?.model === model.id}
            disabled={disabled}
            onRemove={() => onRemove(model)}
            onDescribe={(next) => onDescribe(model, next)}
            onSpeed={(next) => onSpeed(model, next)}
            onStep={(by, from) => step(model.id, by, from)}
            onDragStart={(event) => {
              event.dataTransfer.setData(ROW_DRAG_TYPE, model.id);
              event.dataTransfer.effectAllowed = "move";
              const row = event.currentTarget.closest("[data-roster-row]");
              if (row instanceof HTMLElement) {
                const handle = event.currentTarget.getBoundingClientRect();
                const box = row.getBoundingClientRect();
                event.dataTransfer.setDragImage(row, handle.left - box.left + 12, handle.top - box.top + 12);
              }
              setDrag({ model: model.id, order });
            }}
            onDragEnd={() => setDrag(undefined)}
            {...dragProps(model.id)}
          />
        ))
      )}
    </SettingsCard>
  );
}

/**
 * A model on the roster: its rank, which turns into a handle to move it by, over its name and what it's
 * for, a line to click and rewrite; then its speed, where the model offers a choice, and a button that
 * takes it off. A line cleared, or put back to Cerium's own, stops being the user's.
 */
function RosterRow({
  provider,
  model,
  use,
  speed,
  rank,
  count,
  dragging,
  disabled,
  onRemove,
  onDescribe,
  onSpeed,
  onStep,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDragOver,
  onDrop,
}: {
  provider: ProviderId;
  model: ModelInfo;
  use: string;
  speed: ModelSpeed | undefined;
  /** Its place among the harness's models; undefined when it's the only one. */
  rank: number | undefined;
  /** How many models the harness's roster holds. */
  count: number;
  dragging: boolean;
  disabled: boolean;
  onRemove: () => void;
  onDescribe: (use: string | undefined) => void;
  onSpeed: (speed: ModelSpeed | undefined) => void;
  onStep: (by: -1 | 1, from: "handle" | "button") => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onDragEnter: () => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
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

  const speeds = model.speeds ?? [];
  return (
    <div
      data-roster-row
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`group/row flex min-h-12 items-center gap-3 py-2 pr-2.5 transition-opacity max-md:flex-wrap max-md:gap-y-1 ${
        rank === undefined ? "pl-4" : "pl-1.5"
      } ${dragging ? "opacity-40" : ""}`}
    >
      {rank === undefined ? null : (
        <Tooltip label="Drag to reorder">
          <Button
            data-roster-handle={`${provider}/${model.id}`}
            aria-label={`${model.label}, choice ${rank}. Move with the arrow keys`}
            aria-keyshortcuts="ArrowUp ArrowDown"
            disabled={disabled}
            draggable={!disabled}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              onStep(event.key === "ArrowUp" ? -1 : 1, "handle");
            }}
            className="group/handle relative -mr-1 grid h-8 w-6 shrink-0 cursor-grab pointer-coarse:cursor-default place-items-center rounded-md text-fg-tertiary transition-colors outline-none hover:bg-surface-hover hover:text-fg-primary focus-visible:ring-1 focus-visible:ring-focus-ring active:cursor-grabbing data-disabled:cursor-default"
          >
            <span className="text-meta tabular-nums transition-opacity group-hover/row:opacity-0 group-focus-visible/handle:opacity-0">
              {rank}
            </span>
            <GripVertical
              size={14}
              strokeWidth={1.75}
              className="absolute opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/handle:opacity-100"
            />
          </Button>
        </Tooltip>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body text-fg-primary">{model.label}</span>
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
              // A phone's line wraps to say it all, rather than lose it to the ellipsis.
              className={`-mx-1 max-w-full cursor-text self-start truncate rounded-sm px-1 text-left text-meta leading-relaxed transition-colors outline-none hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-focus-ring max-md:whitespace-normal ${
                own ? "text-fg-secondary" : "text-fg-tertiary"
              }`}
            >
              {use}
            </Button>
          </Tooltip>
        )}
      </div>
      {/* Beside the line on a wide window; a line of its own under it on a phone, where it also holds the
          buttons that move the row, which a touch screen has no handle or arrow keys for. */}
      {speeds.length > 1 || rank !== undefined ? (
        <div
          className={`contents max-md:order-last max-md:flex max-md:basis-full max-md:items-center max-md:gap-1 ${
            rank === undefined ? "" : "max-md:pl-8"
          }`}
        >
          {speeds.length > 1 ? (
            <SelectRoot
              value={speed ?? "default"}
              disabled={disabled}
              onValueChange={(next) => {
                if (next !== null) onSpeed(next === "default" ? undefined : (next as ModelSpeed));
              }}
            >
              <SelectTrigger label={`Speed for ${model.label}`}>
                <SpeedMark speed={speed} />
                <span className={speed === undefined ? "text-fg-tertiary" : ""}>
                  {speed === undefined ? "Default speed" : speedLabel[speed]}
                </span>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem
                  value="default"
                  description={`${speedLabel[model.defaultSpeed ?? "standard"]}, as ${providerName[provider]} is set`}
                >
                  Default speed
                </SelectItem>
                {speeds.map((each) => (
                  <SelectItem key={each} value={each} description={speedHint[each]}>
                    {speedLabel[each]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </SelectRoot>
          ) : null}
          {rank === undefined ? null : (
            <span className="ml-auto hidden items-center max-md:flex pointer-coarse:flex">
              {(
                [
                  { by: -1, label: "up", icon: ChevronUp, end: rank === 1 },
                  { by: 1, label: "down", icon: ChevronDown, end: rank === count },
                ] as const
              ).map(({ by, label, icon: Icon, end }) => (
                <Button
                  key={label}
                  data-roster-move={`${provider}/${model.id}:${by}`}
                  aria-label={`Move ${model.label} ${label}`}
                  disabled={disabled || end}
                  onClick={() => onStep(by, "button")}
                  className="grid size-9 place-items-center rounded-md text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary active:bg-surface-active data-disabled:opacity-30"
                >
                  <Icon size={16} strokeWidth={1.75} />
                </Button>
              ))}
            </span>
          )}
        </div>
      ) : null}
      <Tooltip label="Take off the roster">
        <Button
          aria-label={`Take ${model.label} off the roster`}
          disabled={disabled}
          onClick={onRemove}
          className="grid size-7 shrink-0 place-items-center rounded-md text-fg-tertiary opacity-0 transition-[opacity,color,background-color] group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-surface-hover hover:text-fg-primary focus-visible:opacity-100 max-md:size-9 max-md:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100"
        >
          <X size={14} strokeWidth={1.75} />
        </Button>
      </Tooltip>
    </div>
  );
}
