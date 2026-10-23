import { Combobox } from "@base-ui/react/combobox";
import { Switch } from "@base-ui/react/switch";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { ModelInfo, ProviderId } from "@cerium/protocol";
import { useAtom } from "@effect/atom-react";
import { Check, Search, Star } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { triggerClass } from "../../components/ui/Select.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { keyLabel, primaryHeld } from "../../lib/keys.ts";
import { providerName } from "../threads/model.ts";
import { favoriteModelsAtom, toggleFavorite } from "./favorites.ts";
import { findModels, modelKey } from "./models.ts";

// The model menu in the message box: a rail down its side holds the starred models and a tab per
// harness, a search spans every harness's models, and Ctrl and a digit picks one of the first ten
// rows. It picks one model, or several for multi agent.

/** What the model picker's trigger shows: the model in use, which the list may not offer any more. */
export interface ShownModel {
  readonly provider: ProviderId;
  readonly label: string;
  /** Its `modelKey`; absent when the list doesn't hold it. */
  readonly key?: string;
}

/** What the rail shows: the starred models, or one harness's. */
type Tab = ProviderId | "favorites";

/** A group of the menu's list, by `modelKey`: one harness's models, or the starred ones. */
interface ModelGroup {
  readonly value: Tab;
  readonly items: ReadonlyArray<string>;
}

interface MenuProps {
  readonly models: ReadonlyArray<ModelInfo>;
  /** The harnesses to list, in order. With one there is no rail. */
  readonly providers: ReadonlyArray<ProviderId>;
  /** The harnesses that can run now; the others get a tab that says so, without models. */
  readonly available: ReadonlySet<ProviderId>;
  /** Said above the menu's foot. */
  readonly note?: string;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

/** The search, the rail's tab and the starred models, and the list they show. */
function useBrowse(
  { models, providers, available, open, onOpenChange }: MenuProps,
  home: { readonly provider: ProviderId; readonly key?: string | undefined } | undefined,
) {
  // Always controlled: the box swaps a caller that holds the open state for one that doesn't.
  const [ownOpen, setOwnOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useAtom(favoriteModelsAtom);
  const listed = models.filter(
    (model) => providers.includes(model.provider) && available.has(model.provider),
  );
  const byKey = new Map(listed.map((model) => [modelKey(model), model]));
  const starred = favorites.filter((key) => byKey.has(key));
  const railed = providers.length > 1;
  /** The tab picked since the menu opened; until then the starred models when they hold the one in
   * use, else its harness. */
  const [picked, setPicked] = useState<Tab>();
  const tab: Tab | undefined =
    picked ??
    (railed && home?.key !== undefined && starred.includes(home.key) ? "favorites" : home?.provider) ??
    providers.find((provider) => available.has(provider)) ??
    providers[0];
  const grouped = (list: ReadonlyArray<ModelInfo>): ReadonlyArray<ModelGroup> =>
    providers.flatMap((provider) => {
      const items = list.filter((model) => model.provider === provider).map(modelKey);
      return items.length === 0 ? [] : [{ value: provider, items }];
    });
  const searching = query.trim() !== "";
  // A search spans every harness; otherwise the list is the tab's.
  const shown: ReadonlyArray<ModelGroup> = searching
    ? grouped(findModels(listed, query))
    : tab === "favorites"
      ? starred.length === 0
        ? []
        : [{ value: "favorites", items: starred }]
      : grouped(listed).filter((group) => group.value === tab);
  return {
    open: open ?? ownOpen,
    setOpen: (next: boolean) => {
      setOwnOpen(next);
      onOpenChange?.(next);
    },
    query,
    setQuery,
    tab,
    setTab: setPicked,
    searching,
    railed,
    byKey,
    groups: grouped(listed),
    shown,
    /** The rows in the order shown: Ctrl 1 to 9 pick the first nine, Ctrl 0 the tenth. */
    order: shown.flatMap((group) => group.items),
    /** Whether the rows mix harnesses, so each carries its harness's mark. */
    mixed: railed && (searching || tab === "favorites"),
    favorites,
    toggleFavorite: (key: string) => setFavorites(toggleFavorite(favorites, key)),
    /** Back to the default tab, with nothing typed, for the next time it opens. */
    reset: () => {
      setQuery("");
      setPicked(undefined);
    },
  };
}

type Browse = ReturnType<typeof useBrowse>;

/** Picks one model. `onMulti` offers multi agent at the menu's foot. */
export function ModelPicker({
  shown,
  onPick,
  onMulti,
  ...menu
}: MenuProps & {
  /** Undefined while no harness has listed a model yet. */
  readonly shown: ShownModel | undefined;
  readonly onPick: (model: ModelInfo) => void;
  readonly onMulti?: () => void;
}) {
  const browse = useBrowse(menu, shown);
  const pick = (key: string | null) => {
    const picked = key === null ? undefined : browse.byKey.get(key);
    if (picked !== undefined) onPick(picked);
  };
  return (
    <Combobox.Root<string, false, ModelGroup>
      items={browse.groups}
      filteredItems={browse.shown}
      value={shown?.key ?? null}
      onValueChange={pick}
      inputValue={browse.query}
      onInputValueChange={(value, details) => {
        // Picking would put the model's name in the search as the menu closes.
        if (!details.isItemPress) browse.setQuery(value);
      }}
      open={browse.open}
      onOpenChange={browse.setOpen}
      onOpenChangeComplete={(open) => {
        if (!open) browse.reset();
      }}
      autoHighlight
    >
      <Combobox.Trigger aria-label="Model" className={triggerClass}>
        {shown ? (
          <>
            <ProviderLogo provider={shown.provider} size={13} />
            <span className="font-medium text-fg-primary">{shown.label}</span>
          </>
        ) : (
          <span className="text-fg-tertiary">Finding models…</span>
        )}
      </Combobox.Trigger>
      <MenuPopup
        {...menu}
        browse={browse}
        onShortcut={(key) => {
          pick(key);
          browse.setOpen(false);
        }}
        footer={onMulti ? <SeveralSwitch on={false} onChange={onMulti} /> : undefined}
      />
    </Combobox.Root>
  );
}

/**
 * Multi agent: picks the models a new thread's first message goes to, a thread each, side by side.
 * At least one stays picked, and no more than `max`.
 */
export function ModelsPicker({
  chosen,
  max,
  onPick,
  onSingle,
  ...menu
}: MenuProps & {
  /** The models picked, in the order picked. */
  readonly chosen: ReadonlyArray<ModelInfo>;
  readonly max: number;
  readonly onPick: (keys: ReadonlyArray<string>) => void;
  /** Turns multi agent off, back to one model. */
  readonly onSingle: () => void;
}) {
  const keys = chosen.map(modelKey);
  const browse = useBrowse(menu, chosen[0] && { provider: chosen[0].provider, key: keys[0] });
  const label =
    chosen.length === 1 ? chosen[0]!.label : chosen.length === 0 ? "Pick models" : `${chosen.length} models`;
  const pick = (next: ReadonlyArray<string>) => {
    // Kept in the order picked: the first goes on the left.
    const ordered = [
      ...keys.filter((key) => next.includes(key)),
      ...next.filter((key) => !keys.includes(key)),
    ];
    if (ordered.length > 0 && ordered.length <= max) onPick(ordered);
  };
  return (
    <Combobox.Root<string, true, ModelGroup>
      multiple
      items={browse.groups}
      filteredItems={browse.shown}
      value={keys}
      onValueChange={pick}
      inputValue={browse.query}
      onInputValueChange={(value, details) => {
        // Keeps the search after a pick, so several of its matches can be picked in a row.
        if (!details.isItemPress) browse.setQuery(value);
      }}
      open={browse.open}
      onOpenChange={browse.setOpen}
      onOpenChangeComplete={(open) => {
        if (!open) browse.reset();
      }}
      autoHighlight
    >
      <Combobox.Trigger aria-label="Models" className={triggerClass}>
        {chosen.length > 0 ? (
          // Each harness among them once.
          <span className="flex items-center gap-1">
            {[...new Set(chosen.map((model) => model.provider))].map((provider) => (
              <ProviderLogo key={provider} provider={provider} size={13} />
            ))}
          </span>
        ) : null}
        <span className="font-medium text-fg-primary">{label}</span>
      </Combobox.Trigger>
      <MenuPopup
        {...menu}
        browse={browse}
        multiple
        full={keys.length >= max}
        chosen={keys}
        onShortcut={(key) => pick(keys.includes(key) ? keys.filter((each) => each !== key) : [...keys, key])}
        footer={
          <SeveralSwitch on onChange={onSingle}>
            <span className="text-fg-tertiary tabular-nums">
              {keys.length} of {max}
            </span>
          </SeveralSwitch>
        }
      />
    </Combobox.Root>
  );
}

function MenuPopup({
  providers,
  available,
  note,
  browse,
  multiple = false,
  full = false,
  chosen,
  onShortcut,
  footer,
}: MenuProps & {
  readonly browse: Browse;
  readonly multiple?: boolean;
  /** No more can be chosen: the rows not chosen yet wait. */
  readonly full?: boolean;
  readonly chosen?: ReadonlyArray<string>;
  /** Picks, or in multi agent flips, the row a Ctrl digit names. */
  readonly onShortcut: (key: string) => void;
  readonly footer?: ReactNode;
}) {
  const tabs: ReadonlyArray<Tab> = ["favorites", ...providers];
  const waits = (key: string) => full && chosen?.includes(key) !== true;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Ctrl and a digit picks a row, before the window's own Ctrl digits (the sidebar's) see it.
    const digit = /^Digit(\d)$/.exec(event.code)?.[1];
    if (digit !== undefined && primaryHeld(event) && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      const key = browse.order[digit === "0" ? 9 : Number(digit) - 1];
      if (key !== undefined && !waits(key)) onShortcut(key);
      return;
    }
    // Left and right in an empty search move along the rail.
    if (!browse.railed || browse.query !== "" || (event.key !== "ArrowLeft" && event.key !== "ArrowRight"))
      return;
    event.preventDefault();
    const at = tabs.indexOf(browse.tab ?? "favorites");
    const step = event.key === "ArrowLeft" ? -1 : 1;
    browse.setTab(tabs[(at + step + tabs.length) % tabs.length]);
  };
  const empty = browse.searching
    ? "No model matches"
    : browse.tab === "favorites"
      ? "Star a model to keep it here"
      : browse.tab && !available.has(browse.tab)
        ? `${providerName[browse.tab]} isn't ready. Settings → Harnesses says why.`
        : "No models listed yet";
  return (
    <Combobox.Portal>
      <Combobox.Positioner side="top" align="start" sideOffset={6} className="z-50 outline-none">
        <Combobox.Popup
          aria-label="Models"
          className="flex w-96 max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0"
        >
          {browse.railed ? <Rail tabs={tabs} available={available} browse={browse} /> : null}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="mx-2.5 flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle transition-colors focus-within:border-accent">
              <Search size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
              <Combobox.Input
                placeholder="Search models"
                aria-label="Search models"
                onKeyDown={onKeyDown}
                className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-fg-primary outline-none placeholder:text-fg-tertiary max-md:text-[15px]"
              />
            </div>
            {/* With a rail, the list keeps one height, so switching tab doesn't move the menu. */}
            <ScrollArea
              className={browse.railed ? "h-[min(17rem,calc(var(--available-height)-6rem))]" : ""}
              viewportClassName={`scroll-py-1 ${browse.railed ? "" : "max-h-[min(17rem,calc(var(--available-height)-4rem))]"}`}
            >
              <Combobox.Empty>
                <p className="px-3 py-5 text-center text-[12.5px] leading-relaxed text-fg-tertiary">
                  {empty}
                </p>
              </Combobox.Empty>
              <Combobox.List className="p-1.5 empty:p-0">
                {(group: ModelGroup) => (
                  <Combobox.Group key={group.value} items={group.items}>
                    <Combobox.Collection>
                      {(key: string) => {
                        const model = browse.byKey.get(key);
                        const at = browse.order.indexOf(key);
                        return model ? (
                          <ModelRow
                            key={key}
                            model={model}
                            browse={browse}
                            multiple={multiple}
                            disabled={waits(key)}
                            {...(at >= 0 && at < 10 ? { shortcut: `Ctrl ${(at + 1) % 10}` } : {})}
                          />
                        ) : null;
                      }}
                    </Combobox.Collection>
                  </Combobox.Group>
                )}
              </Combobox.List>
            </ScrollArea>
            {note ? (
              <p className="border-t border-line-subtle px-2.5 py-1.5 text-2xs text-fg-tertiary">{note}</p>
            ) : null}
            {footer}
          </div>
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  );
}

/** The menu's side: the starred models, then a tab per harness. One that can't run is dimmed but
 * still opens, to say so. */
function Rail({
  tabs,
  available,
  browse,
}: {
  readonly tabs: ReadonlyArray<Tab>;
  readonly available: ReadonlySet<ProviderId>;
  readonly browse: Browse;
}) {
  return (
    <ToggleGroup
      // While searching, the results span every harness, so none is the tab.
      value={browse.searching || browse.tab === undefined ? [] : [browse.tab]}
      onValueChange={(value) => {
        const next = value[0] as Tab | undefined;
        if (next === undefined) return;
        browse.setTab(next);
        browse.setQuery("");
      }}
      orientation="vertical"
      aria-label="Harness"
      className="flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line-subtle bg-surface-sunken/40 py-1.5 max-md:w-13"
    >
      {tabs.map((tab) => (
        <Tooltip key={tab} label={tab === "favorites" ? "Favorites" : providerName[tab]} side="right">
          <Toggle
            value={tab}
            aria-label={tab === "favorites" ? "Favorites" : providerName[tab]}
            // The search keeps focus, so typing and the arrow keys carry on after a click.
            onMouseDown={(event) => event.preventDefault()}
            className="relative grid size-8 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors select-none after:absolute after:inset-y-2 after:-right-1.5 after:w-0.5 after:rounded-full after:bg-accent after:opacity-0 after:transition-opacity hover:bg-surface-hover hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary data-pressed:after:opacity-100 max-md:size-10"
          >
            {tab === "favorites" ? (
              <Star size={15} strokeWidth={1.75} className="fill-current" />
            ) : (
              <ProviderLogo
                provider={tab}
                size={16}
                {...(available.has(tab) ? {} : { className: "opacity-35 grayscale" })}
              />
            )}
          </Toggle>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}

function ModelRow({
  model,
  browse,
  multiple,
  disabled,
  shortcut,
}: {
  readonly model: ModelInfo;
  readonly browse: Browse;
  readonly multiple: boolean;
  readonly disabled: boolean;
  /** The Ctrl digit that picks it, among the first ten rows. */
  readonly shortcut?: string;
}) {
  const key = modelKey(model);
  const starred = browse.favorites.includes(key);
  return (
    // The star sits beside the row rather than in it: a click on it stars, and doesn't pick.
    <div className="group/row relative">
      <Combobox.Item
        value={key}
        disabled={disabled}
        className="group/item flex h-8 cursor-default items-center gap-2 rounded-md pr-9 pl-2 text-[13px] text-fg-secondary outline-none select-none data-disabled:opacity-40 data-highlighted:bg-surface-hover data-highlighted:text-fg-primary data-selected:text-fg-primary max-md:h-11 max-md:text-[15px]"
      >
        {multiple ? (
          <span className="grid size-3.5 shrink-0 place-items-center rounded-[4px] border border-line-strong text-accent-fg transition-colors group-data-selected/item:border-accent group-data-selected/item:bg-accent">
            <Combobox.ItemIndicator>
              <Check size={10} strokeWidth={3} />
            </Combobox.ItemIndicator>
          </span>
        ) : null}
        {browse.mixed ? <ProviderLogo provider={model.provider} size={13} /> : null}
        <span className="min-w-0 flex-1 truncate group-data-selected/item:font-medium">{model.label}</span>
        {multiple ? null : (
          <Combobox.ItemIndicator className="shrink-0 text-fg-secondary">
            <Check size={13} strokeWidth={2.25} />
          </Combobox.ItemIndicator>
        )}
        {shortcut ? (
          <kbd className="shrink-0 rounded-[5px] bg-surface-sunken px-1.5 py-0.5 font-sans text-2xs text-fg-tertiary tabular-nums max-md:hidden">
            {keyLabel(shortcut)}
          </kbd>
        ) : null}
      </Combobox.Item>
      <button
        type="button"
        tabIndex={-1}
        aria-label={starred ? `Unstar ${model.label}` : `Star ${model.label}`}
        aria-pressed={starred}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => browse.toggleFavorite(key)}
        className={`absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-md transition-colors hover:bg-surface-active max-md:size-8 ${starred ? "text-attention" : "text-fg-disabled hover:text-fg-secondary"}`}
      >
        <Star size={13} strokeWidth={1.75} className={starred ? "fill-current" : ""} />
      </button>
    </div>
  );
}

/** The menu's foot: multi agent on or off, with what goes beside it. */
function SeveralSwitch({
  on,
  onChange,
  children,
}: {
  readonly on: boolean;
  readonly onChange: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-t border-line-subtle px-2.5 text-[12.5px] max-md:h-11">
      {/* The whole row is the switch, so its words name it and a click on them flips it. */}
      <Switch.Root
        checked={on}
        onCheckedChange={onChange}
        className="group/switch flex cursor-default items-center gap-2 rounded-md text-fg-secondary outline-none select-none hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <span className="flex h-4 w-7 shrink-0 rounded-full bg-line-strong p-0.5 transition-colors duration-200 ease-out-soft group-data-checked/switch:bg-accent">
          <Switch.Thumb className="size-3 rounded-full bg-fg-primary shadow-raised transition-[translate,background-color] duration-200 ease-out-soft data-checked:translate-x-3 data-checked:bg-accent-fg" />
        </span>
        Several at once
      </Switch.Root>
      <span className="ml-auto">{children}</span>
    </div>
  );
}
