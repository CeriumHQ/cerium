import { Combobox } from "@base-ui/react/combobox";
import { Switch } from "@base-ui/react/switch";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { ModelInfo, ProviderId } from "@cerium/protocol";
import { Check, ChevronDown, Search } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { triggerClass } from "../../components/ui/Select.tsx";
import { providerName } from "../threads/model.ts";
import { findModels, modelKey } from "./models.ts";

// The model menu in the message box: a search over every harness's models, and a tab per harness to
// browse one harness's models at a time. It picks one model, or several for multi agent.

/** What the model picker's trigger shows: the model in use, which the list may not offer any more. */
export interface ShownModel {
  readonly provider: ProviderId;
  readonly label: string;
  /** Its `modelKey`; absent when the list doesn't hold it. */
  readonly key?: string;
}

/** One harness's models, by `modelKey`: a group of the menu's list. */
interface ModelGroup {
  readonly value: ProviderId;
  readonly items: ReadonlyArray<string>;
}

interface MenuProps {
  readonly models: ReadonlyArray<ModelInfo>;
  /** The harnesses to list, in order. With one there are no tabs. */
  readonly providers: ReadonlyArray<ProviderId>;
  /** The harnesses that can run now; the others get a tab that says so, without models. */
  readonly available: ReadonlySet<ProviderId>;
  /** Said above the menu's foot. */
  readonly note?: string;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

/** The search and the harness tab, and the list they show. */
function useBrowse(
  { models, providers, available, open, onOpenChange }: MenuProps,
  home: ProviderId | undefined,
) {
  // Always controlled: the box swaps a caller that holds the open state for one that doesn't.
  const [ownOpen, setOwnOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** The tab picked since the menu opened; until then, the harness of the model in use. */
  const [picked, setPicked] = useState<ProviderId>();
  const tab = picked ?? home ?? providers.find((provider) => available.has(provider)) ?? providers[0];
  const listed = models.filter(
    (model) => providers.includes(model.provider) && available.has(model.provider),
  );
  const grouped = (list: ReadonlyArray<ModelInfo>): ReadonlyArray<ModelGroup> =>
    providers.flatMap((provider) => {
      const items = list.filter((model) => model.provider === provider).map(modelKey);
      return items.length === 0 ? [] : [{ value: provider, items }];
    });
  const searching = query.trim() !== "";
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
    byKey: new Map(listed.map((model) => [modelKey(model), model])),
    groups: grouped(listed),
    // A search spans every harness; otherwise the list is the tab's harness.
    shown: searching
      ? grouped(findModels(listed, query))
      : grouped(listed).filter((group) => group.value === tab),
    /** Back to the harness of the model in use, with nothing typed, for the next time it opens. */
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
  const browse = useBrowse(menu, shown?.provider);
  return (
    <Combobox.Root<string, false, ModelGroup>
      items={browse.groups}
      filteredItems={browse.shown}
      value={shown?.key ?? null}
      onValueChange={(key) => {
        const picked = key === null ? undefined : browse.byKey.get(key);
        if (picked !== undefined) onPick(picked);
      }}
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
        <ChevronDown size={12} strokeWidth={2} className="text-fg-tertiary" />
      </Combobox.Trigger>
      <MenuPopup
        {...menu}
        browse={browse}
        holding={new Set(shown?.key ? [shown.provider] : [])}
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
  const browse = useBrowse(menu, chosen[0]?.provider);
  const keys = chosen.map(modelKey);
  const label =
    chosen.length === 1 ? chosen[0]!.label : chosen.length === 0 ? "Pick models" : `${chosen.length} models`;
  return (
    <Combobox.Root<string, true, ModelGroup>
      multiple
      items={browse.groups}
      filteredItems={browse.shown}
      value={keys}
      onValueChange={(next) => {
        // Kept in the order picked: the first goes on the left.
        const ordered = [
          ...keys.filter((key) => next.includes(key)),
          ...next.filter((key) => !keys.includes(key)),
        ];
        if (ordered.length > 0 && ordered.length <= max) onPick(ordered);
      }}
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
        <ChevronDown size={12} strokeWidth={2} className="text-fg-tertiary" />
      </Combobox.Trigger>
      <MenuPopup
        {...menu}
        browse={browse}
        holding={new Set(chosen.map((model) => model.provider))}
        multiple
        full={keys.length >= max}
        chosen={keys}
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
  holding,
  multiple = false,
  full = false,
  chosen,
  footer,
}: MenuProps & {
  readonly browse: Browse;
  /** The harnesses that hold the pick: their tabs carry a dot. */
  readonly holding: ReadonlySet<ProviderId>;
  readonly multiple?: boolean;
  /** No more can be chosen: the rows not chosen yet wait. */
  readonly full?: boolean;
  readonly chosen?: ReadonlyArray<string>;
  readonly footer?: ReactNode;
}) {
  const tabbed = providers.length > 1;
  /** Left and right in an empty search move between the harness tabs. */
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!tabbed || browse.query !== "" || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const at = providers.indexOf(browse.tab ?? providers[0]!);
    const step = event.key === "ArrowLeft" ? -1 : 1;
    browse.setTab(providers[(at + step + providers.length) % providers.length]);
  };
  return (
    <Combobox.Portal>
      <Combobox.Positioner side="top" align="start" sideOffset={6} className="z-50 outline-none">
        <Combobox.Popup
          aria-label="Models"
          className="flex w-68 max-w-(--available-width) origin-(--transform-origin) flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0"
        >
          <div className="flex h-9 shrink-0 items-center gap-2 px-2.5">
            <Search size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
            <Combobox.Input
              placeholder="Search models"
              aria-label="Search models"
              onKeyDown={onKeyDown}
              className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-fg-primary outline-none placeholder:text-fg-tertiary max-md:text-[15px]"
            />
          </div>
          {tabbed ? (
            <HarnessTabs providers={providers} available={available} browse={browse} holding={holding} />
          ) : null}
          {/* With tabs, the list keeps one height, so switching harness doesn't move the tabs. */}
          <ScrollArea
            className={`border-t border-line-subtle ${tabbed ? "h-[min(15rem,calc(var(--available-height)-6rem))]" : ""}`}
            viewportClassName={`scroll-py-1 ${tabbed ? "" : "max-h-[min(15rem,calc(var(--available-height)-4rem))]"}`}
          >
            <Combobox.Empty>
              <p className="px-3 py-5 text-center text-[12.5px] leading-relaxed text-fg-tertiary">
                {browse.searching
                  ? "No model matches"
                  : browse.tab && !available.has(browse.tab)
                    ? `${providerName[browse.tab]} isn't ready. Settings → Harnesses says why.`
                    : "No models listed yet"}
              </p>
            </Combobox.Empty>
            <Combobox.List className="p-1 empty:p-0">
              {(group: ModelGroup) => (
                <Combobox.Group key={group.value} items={group.items}>
                  {/* Results span harnesses: each is named over its own. */}
                  {browse.searching && tabbed ? (
                    <Combobox.GroupLabel className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-2xs font-medium text-fg-tertiary">
                      <ProviderLogo provider={group.value} size={11} />
                      {providerName[group.value]}
                    </Combobox.GroupLabel>
                  ) : null}
                  <Combobox.Collection>
                    {(key: string) => {
                      const model = browse.byKey.get(key);
                      return model ? (
                        <ModelRow
                          key={key}
                          model={model}
                          multiple={multiple}
                          disabled={full && chosen?.includes(key) !== true}
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
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  );
}

/** A tab per harness, named; one that can't run is dimmed but still opens, to say so. */
function HarnessTabs({
  providers,
  available,
  browse,
  holding,
}: {
  readonly providers: ReadonlyArray<ProviderId>;
  readonly available: ReadonlySet<ProviderId>;
  readonly browse: Browse;
  readonly holding: ReadonlySet<ProviderId>;
}) {
  return (
    <ToggleGroup
      // While searching, the results span every harness, so none is the tab.
      value={browse.searching || browse.tab === undefined ? [] : [browse.tab]}
      onValueChange={(value) => {
        const next = value[0] as ProviderId | undefined;
        if (next === undefined) return;
        browse.setTab(next);
        browse.setQuery("");
      }}
      aria-label="Harness"
      className="flex shrink-0 gap-0.5 overflow-x-auto px-1.5 pb-1.5"
    >
      {providers.map((provider) => (
        <Toggle
          key={provider}
          value={provider}
          // The search keeps focus, so typing and the arrow keys carry on after a click.
          onMouseDown={(event) => event.preventDefault()}
          className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-fg-tertiary transition-colors select-none hover:bg-surface-hover hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:h-8 max-md:text-[14px]"
        >
          <ProviderLogo
            provider={provider}
            size={12}
            {...(available.has(provider) ? {} : { className: "opacity-35 grayscale" })}
          />
          {providerName[provider]}
          {holding.has(provider) ? <span aria-hidden className="size-1.5 rounded-full bg-accent" /> : null}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

function ModelRow({
  model,
  multiple,
  disabled,
}: {
  readonly model: ModelInfo;
  readonly multiple: boolean;
  readonly disabled: boolean;
}) {
  return (
    <Combobox.Item
      value={modelKey(model)}
      disabled={disabled}
      className="group/item flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-fg-secondary outline-none select-none data-disabled:opacity-40 data-highlighted:bg-surface-hover data-highlighted:text-fg-primary data-selected:text-fg-primary max-md:py-2.5 max-md:text-[15px]"
    >
      {multiple ? (
        <span className="grid size-3.5 shrink-0 place-items-center rounded-[4px] border border-line-strong text-accent-fg transition-colors group-data-selected/item:border-accent group-data-selected/item:bg-accent">
          <Combobox.ItemIndicator>
            <Check size={10} strokeWidth={3} />
          </Combobox.ItemIndicator>
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{model.label}</span>
      {multiple ? null : (
        <Combobox.ItemIndicator className="shrink-0 text-fg-secondary">
          <Check size={13} strokeWidth={2.25} />
        </Combobox.ItemIndicator>
      )}
    </Combobox.Item>
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
